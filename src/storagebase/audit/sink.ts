import { randomUUID } from "node:crypto";
import { MAX_AUDIT_FIELD_LENGTH, redactUriCredentials, type AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { onShutdown } from "@/lib/shutdown";
import type { QueryEventInput } from "@/lib/query-events/types";
import { getForkStore } from "@/storagebase/store";
import { MAX_AUDIT_STATEMENT_LENGTH } from "./masker";
import { storagebaseQueryEvent } from "./query-event";
import {
  STORAGEBASE_AUDIT_SCHEMA,
  type StoragebaseAuditCounts,
  type StoragebaseAuditEvent,
  type StoragebaseAuditEventInput,
} from "./types";
import { storagebaseEventFromUpstream } from "./upstream";

/**
 * The fork's audit sink (StorageBase fork): where every fork audit event waits until the fork
 * store holds it. The three recording paths all land here — the S2 query tap and the S3 upstream
 * tap through src/storagebase/core/seams.ts, and the fork's own resource routes
 * (src/storagebase/audit/resource.ts) directly.
 *
 * It mirrors the discipline of upstream's own query-event sink (src/lib/query-events/sink.ts): a
 * bounded queue, never a throw, a backoff on a failed write, and a shutdown flush. `record…` never
 * throws and never waits: the event is sanitized now, and both destinations get it later.
 *
 * The two destinations, in the order they are reached:
 *
 * 1. ONE STDOUT JSON LINE PER EVENT, schema `storagebase.audit.v1`, printed when the event's batch
 *    first reaches a flush — so a log pipeline (Graylog / Elastic SIEM) gets the trail without the
 *    database, and a store that is down does not duplicate the line on the retry. The print rides
 *    the flush rather than the record on purpose: upstream tests spy stdout around a single awaited
 *    route call, and a synchronous print here would put a second JSON line inside their windows.
 *    The line is an explicit allowlist (never a spread of the event), so a field added to the
 *    schema later cannot silently start being logged.
 *
 * 2. THE DURABLE STORE, through `appendAuditEvent`: the head batch of the queue, one insert per
 *    event, idempotent (`ON CONFLICT (id) DO NOTHING`), so a retry after a partial write adds
 *    nothing. A failed write leaves the rest of the batch at the head and backs off (1 s doubling
 *    to 30 s) until one settles its whole batch. With `local` storage there is no store to write:
 *    the batch drains (its lines have already been printed) and nothing is counted as dropped.
 *    Retention rides on the store's own append (an hourly prune past
 *    STORAGEBASE_AUDIT_RETENTION_DAYS).
 *
 * The queue holds at most 10 000 events. One more is dropped and counted, the newest, and the
 * first drop of each spell of a full queue is logged. Every dropped event has already been printed
 * and is still in the ring, so the trail loses only its durable copy.
 *
 * The RING (bounded at 1000, upstream's MAX_EVENTS) is what the admin page reads when there is no
 * durable store to answer it: the last 1000 fork events, in memory. Upstream events are not re-rung
 * — they already sit in upstream's own buffer, which the admin fallback reads beside this one.
 *
 * At shutdown the hook `storagebase-audit-flush` prints and writes what is queued, batch after
 * batch and without waiting out the backoff, for at most 4 s, and logs how many it could not send.
 * It is registered with the events, so a process that records none has nothing to flush.
 */

/** The most events the queue holds. */
export const STORAGEBASE_AUDIT_QUEUE_CAPACITY = 10_000;
/** The most events one flush writes, and the queue length that flushes at once. */
export const STORAGEBASE_AUDIT_BATCH_ROWS = 500;
/** The longest an event waits for its write while the sink does not back off. */
const FLUSH_INTERVAL_MS = 1000;
/** The first backoff step after a failed write, doubling up to the cap. */
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The deadline of the shutdown flush: under the 5 s the shutdown gives every hook. */
const SHUTDOWN_FLUSH_DEADLINE_MS = 4000;
/** How many of the newest fork events the ring keeps: upstream's own MAX_EVENTS. */
const RING_CAPACITY = 1000;
/** The bound on `counts`: a handful of facts, never a payload. */
export const MAX_AUDIT_COUNTS = 8;
const COUNT_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const SHUTDOWN_HOOK = "storagebase-audit-flush";
const ROUTE = "storagebase-audit";

/** The wait before the next flush after `failures` failed writes in a row. */
export function storagebaseAuditBackoffMs(failures: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

// ── The sanitizer: the one gate every fork event passes before either destination ──

/** Per-field bounds that differ from MAX_AUDIT_FIELD_LENGTH, keyed by field name. */
const FIELD_LENGTH_OVERRIDES: Readonly<Record<string, number>> = { statement: MAX_AUDIT_STATEMENT_LENGTH };
/**
 * The fields whose legitimate value is not a string, by NAME (the reason is upstream's: the runtime
 * type of a hand-built event cannot be trusted, but the name says what the field is): a number
 * arriving anywhere else is coerced like any other non-string, and so is a string arriving here.
 */
const NUMBER_FIELDS = new Set(["duration", "rowsReturned", "rowsAffected"]);
const BOOLEAN_FIELDS = new Set(["statementTruncated"]);
/** Guards the dynamic `mutable[key] = …` write below, as upstream's sanitizer does. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `counts` reduced to what it may hold: finite numbers and booleans under identifier-shaped keys,
 * at most MAX_AUDIT_COUNTS of them. Undefined when nothing survives, so the field is omitted
 * rather than recorded empty.
 */
function sanitizeCounts(value: unknown): StoragebaseAuditCounts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const kept: Array<[string, number | boolean]> = [];
  for (const [key, count] of Object.entries(value)) {
    if (kept.length >= MAX_AUDIT_COUNTS) break;
    if (!COUNT_KEY.test(key)) continue;
    if ((typeof count === "number" && Number.isFinite(count)) || typeof count === "boolean") kept.push([key, count]);
  }
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The one gate every free-text field passes: strip any URI-shaped credential, then bound. */
function sanitizeField(value: string, field: string): string {
  return redactUriCredentials(value).slice(0, FIELD_LENGTH_OVERRIDES[field] ?? MAX_AUDIT_FIELD_LENGTH);
}

/** A present value that is neither a string nor one of the typed fields, as a bounded string. */
function coerceToString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * The fork's sanitization boundary, applied once to an emitter's input before it reaches either
 * destination. Sweeps every own key of the event and sanitizes any string value found there,
 * unconditionally: a field added to the schema later is covered by construction. `counts` keeps
 * only numbers and booleans; the number and boolean fields keep their own type; everything else
 * that is present and not a string is coerced to a bounded string.
 */
function sanitizeStoragebaseAuditEvent(input: StoragebaseAuditEventInput): StoragebaseAuditEvent {
  // Omit<X, never> is X's own shape as a mapped type, which carries the implicit index signature
  // the dynamic view below needs — the same property upstream's Omit-typed sanitizer variable has
  // and a plain interface does not.
  const event: Omit<StoragebaseAuditEvent, never> = {
    ...input,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  // A second, dynamically-keyed view of the SAME object (not a copy, no cast): both names refer
  // to one object, so mutating through this view mutates `event`.
  const mutable: Record<string, unknown> = event;
  for (const key of Object.keys(mutable)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const value = mutable[key];
    if (typeof value === "string") {
      mutable[key] = sanitizeField(value, key);
    } else if (key === "counts") {
      const counts = sanitizeCounts(value);
      if (counts === undefined) delete mutable[key];
      else mutable[key] = counts;
    } else if (value !== undefined && NUMBER_FIELDS.has(key) && typeof value === "number") {
      // The field's own number, kept as one.
    } else if (value !== undefined && BOOLEAN_FIELDS.has(key) && typeof value === "boolean") {
      // The field's own boolean, kept as one.
    } else if (value !== undefined) {
      mutable[key] = sanitizeField(coerceToString(value), key);
    }
  }
  return event;
}

// ── The stdout line: an explicit allowlist, never a spread of the event ──

interface StoragebaseAuditLogLine {
  schema: string;
  ts: string;
  id: string;
  event: StoragebaseAuditEvent["type"];
  action: string;
  outcome: "success" | "failure";
  actor: string;
  route: string;
  reason?: string;
  ip?: string;
  connection?: string;
  duration_ms?: number;
  bucket?: string;
  correlation_id?: string;
  container?: string;
  engine_user?: string;
  passkey?: string;
  role?: string;
  user_agent?: string;
  forwarded_for?: string;
  connection_id?: string;
  engine?: string;
  host?: string;
  database?: string;
  statement_kind?: StoragebaseAuditEvent["statementKind"];
  statement?: string;
  statement_truncated?: boolean;
  rows_returned?: number;
  rows_affected?: number;
  error?: string;
  query_id?: string;
  counts?: StoragebaseAuditCounts;
  auth_provider?: string;
  subject?: string;
  app_roles?: string;
  permission?: string;
  granted_by?: string;
  access_groups?: string;
}

/** A number that may reach the line: finite, so the field's JSON type never flips to null. */
function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function toStoragebaseAuditLine(event: StoragebaseAuditEvent): StoragebaseAuditLogLine {
  return {
    schema: STORAGEBASE_AUDIT_SCHEMA,
    ts: event.timestamp,
    id: event.id,
    event: event.type,
    action: event.action,
    outcome: event.result,
    actor: event.user,
    route: event.target,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.ip ? { ip: event.ip } : {}),
    ...(event.connectionName ? { connection: event.connectionName } : {}),
    ...(finiteNumber(event.duration) ? { duration_ms: event.duration } : {}),
    ...(event.bucket ? { bucket: event.bucket } : {}),
    ...(event.correlationId ? { correlation_id: event.correlationId } : {}),
    ...(event.container ? { container: event.container } : {}),
    ...(event.engineUser ? { engine_user: event.engineUser } : {}),
    ...(event.passkey ? { passkey: event.passkey } : {}),
    ...(event.role ? { role: event.role } : {}),
    ...(event.userAgent ? { user_agent: event.userAgent } : {}),
    ...(event.forwardedFor ? { forwarded_for: event.forwardedFor } : {}),
    ...(event.connectionId ? { connection_id: event.connectionId } : {}),
    ...(event.engine ? { engine: event.engine } : {}),
    ...(event.host ? { host: event.host } : {}),
    ...(event.database ? { database: event.database } : {}),
    ...(event.statementKind ? { statement_kind: event.statementKind } : {}),
    ...(event.statement !== undefined ? { statement: event.statement } : {}),
    ...(event.statementTruncated ? { statement_truncated: true } : {}),
    ...(finiteNumber(event.rowsReturned) ? { rows_returned: event.rowsReturned } : {}),
    ...(finiteNumber(event.rowsAffected) ? { rows_affected: event.rowsAffected } : {}),
    ...(event.error ? { error: event.error } : {}),
    ...(event.queryId ? { query_id: event.queryId } : {}),
    ...(event.counts ? { counts: event.counts } : {}),
    ...(event.authProvider ? { auth_provider: event.authProvider } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    ...(event.appRoles ? { app_roles: event.appRoles } : {}),
    ...(event.permission ? { permission: event.permission } : {}),
    ...(event.grantedBy ? { granted_by: event.grantedBy } : {}),
    ...(event.accessGroups ? { access_groups: event.accessGroups } : {}),
  };
}

// ── The queue, the ring and the flush ──

/** One queued event, with whether its stdout line has already been printed. */
interface QueuedAuditEvent {
  readonly event: StoragebaseAuditEvent;
  printed: boolean;
}

interface SinkState {
  /** The events the store does not hold yet, oldest first: a flush writes the head. */
  readonly queue: QueuedAuditEvent[];
  /** The newest RING_CAPACITY fork events, oldest first: the admin fallback reads a copy. */
  readonly ring: StoragebaseAuditEvent[];
  dropped: number;
  /** Failed writes in a row: the sink backs off while there is one. */
  failures: number;
  /** Whether an event was dropped since the queue last had room, so each spell is logged once. */
  full: boolean;
  /** The next flush, while one is due. */
  timer?: ReturnType<typeof setTimeout>;
  /** The flush under way. */
  flushing?: Promise<void>;
  /** Set by the shutdown flush, after which no flush is armed. */
  closing: boolean;
}

const SINK_KEY = Symbol.for("storagebase.auditSink");
/** The timers this module's own load pinned (src/storagebase/core/seams.ts sets it), when that
 * module ran first; a process that loaded the sink without it (the fork's own tests) gets this
 * process's own timers, which is the same pair in production either way. */
const PINNED_TIMERS_KEY = Symbol.for("storagebase.auditTimers");

type SinkHolder = { [SINK_KEY]?: SinkState };
type PinnedTimersHolder = {
  [PINNED_TIMERS_KEY]?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
};

/** The timers the sink schedules with: the pinned pair when the seams module pinned one. */
function sinkTimers(): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } {
  return (globalThis as PinnedTimersHolder)[PINNED_TIMERS_KEY] ?? { setTimeout, clearTimeout };
}

const newSink = (): SinkState => ({
  queue: [],
  ring: [],
  dropped: 0,
  failures: 0,
  full: false,
  closing: false,
});

function sinkState(): SinkState {
  const holder = globalThis as SinkHolder;
  holder[SINK_KEY] ??= newSink();
  return holder[SINK_KEY];
}

/** One stdout line, isolated so a broken stdout never fails the write it reports. */
function printLine(item: QueuedAuditEvent): void {
  try {
    // JSON.stringify escapes newlines and control characters, so an attacker-controlled actor
    // cannot forge a second log line. This is why the audit channel does not reuse logger.ts.
    console.log(JSON.stringify(toStoragebaseAuditLine(item.event)));
    item.printed = true;
  } catch (error) {
    logger.error("The StorageBase audit stdout line could not be written", error, { route: ROUTE });
  }
}

/**
 * Writes the batch at the head of the queue: every not-yet-printed line first (once per event,
 * whatever the store does), then one append per event through the store. An append that fails
 * leaves the rest of the batch at the head, printed but unwritten, and the flush backs off; the
 * inserts are idempotent, so the retry adds nothing. It never rejects.
 */
async function writeHead(state: SinkState): Promise<boolean> {
  const batch = state.queue.slice(0, STORAGEBASE_AUDIT_BATCH_ROWS);
  for (const item of batch) {
    if (!item.printed) printLine(item);
  }
  try {
    const store = await getForkStore();
    if (store === null) {
      // Local storage: no durable trail exists, the lines are out, and the queue drains.
      state.queue.splice(0, batch.length);
      state.failures = 0;
      return true;
    }
    let settled = 0;
    try {
      for (const item of batch) {
        // oxlint-disable-next-line no-await-in-loop -- one insert at a time, each idempotent.
        await store.appendAuditEvent(item.event);
        settled += 1;
      }
    } catch (error) {
      logger.warn("The durable StorageBase audit store refused a batch; the rest stays queued", {
        route: ROUTE,
        queued: state.queue.length - settled,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    state.queue.splice(0, settled);
    if (settled === batch.length) {
      state.failures = 0;
      return true;
    }
    state.failures += 1;
    return false;
  } catch (error) {
    // The store could not even be opened: the batch stays, printed and queued.
    state.failures += 1;
    logger.warn("The durable StorageBase audit store could not be opened; the batch stays queued", {
      route: ROUTE,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Writes the head of the queue, then arms the next flush. It never rejects. */
function flush(state: SinkState): void {
  state.flushing = writeHead(state).then(() => {
    state.flushing = undefined;
    schedule(state);
  });
}

/**
 * Arms the next flush: at once when the queue holds a batch, else a second after the event that
 * armed it, or after the backoff while writes fail. Nothing is armed while a flush is under way,
 * which arms the next when it ends, or after the shutdown flush.
 *
 * The timer comes from `sinkTimers()` — the pair pinned at the seams module's load — so a fake
 * clock installed later (upstream's own sink test installs one) cannot capture this flush and
 * count it among the timers it asserts it left behind.
 */
function schedule(state: SinkState): void {
  if (state.closing || state.flushing !== undefined || state.queue.length === 0) return;
  const timers = sinkTimers();
  if (state.failures === 0 && state.queue.length >= STORAGEBASE_AUDIT_BATCH_ROWS) {
    timers.clearTimeout(state.timer);
    state.timer = undefined;
    flush(state);
    return;
  }
  if (state.timer !== undefined) return;
  const delayMs = state.failures === 0 ? FLUSH_INTERVAL_MS : storagebaseAuditBackoffMs(state.failures);
  state.timer = timers.setTimeout(() => {
    state.timer = undefined;
    flush(state);
  }, delayMs);
  // The sink must never hold the process open on its own.
  state.timer.unref?.();
}

function enqueue(state: SinkState, event: StoragebaseAuditEvent): void {
  if (state.queue.length >= STORAGEBASE_AUDIT_QUEUE_CAPACITY) {
    state.dropped += 1;
    if (!state.full) {
      state.full = true;
      logger.warn("The StorageBase audit queue is full: new events are dropped until it has room", {
        route: ROUTE,
        capacity: STORAGEBASE_AUDIT_QUEUE_CAPACITY,
      });
    }
    return;
  }
  state.queue.push({ event, printed: false });
  // The registry keeps one hook per name, so registering it with every event registers it once.
  onShutdown(SHUTDOWN_HOOK, flushStoragebaseAuditEvents);
  schedule(state);
}

// ── The recording API ──

/**
 * Records one fork audit event: builds it, sanitizes it, keeps it in the ring, and queues it for
 * both destinations. The BUILD runs inside the guard too, so a masker or conversion defect is as
 * harmless as a sink failure. It never throws and never waits — a broken sink is the sink's own
 * failure to report, never a failed request.
 */
function recordBuilt(build: () => StoragebaseAuditEventInput): void {
  try {
    const event = sanitizeStoragebaseAuditEvent(build());
    const state = sinkState();
    state.ring.push(event);
    if (state.ring.length > RING_CAPACITY) state.ring.splice(0, state.ring.length - RING_CAPACITY);
    enqueue(state, event);
  } catch (error) {
    logger.error("A StorageBase audit event could not be recorded", error, { route: ROUTE });
  }
}

/** Records one fork audit event an emitter already shaped. */
export function recordStoragebaseAuditEvent(input: StoragebaseAuditEventInput): void {
  recordBuilt(() => input);
}

/** Records one query event handed over by the S2 tap, as a `query_execution` fork event. */
export function storagebaseRecordQueryEvent(input: QueryEventInput): void {
  recordBuilt(() => storagebaseQueryEvent(input));
}

/** Records one upstream audit event handed over by the S3 tap, converted to the fork schema. */
export function storagebaseRecordUpstreamEvent(event: AuditEvent): void {
  recordBuilt(() => storagebaseEventFromUpstream(event));
}

/**
 * The shutdown hook `storagebase-audit-flush`: prints and writes every queued event, batch after
 * batch, without waiting out the backoff, for at most 4 s, stopping after a write that failed (the
 * process is going down; the queue cannot be saved) and logging how many events it could not send.
 * A flush under way ends first. No flush is armed after it.
 */
export async function flushStoragebaseAuditEvents(): Promise<void> {
  const state = (globalThis as SinkHolder)[SINK_KEY];
  if (state === undefined) return;
  state.closing = true;
  sinkTimers().clearTimeout(state.timer);
  state.timer = undefined;
  if (state.flushing !== undefined) await state.flushing;
  const deadline = Date.now() + SHUTDOWN_FLUSH_DEADLINE_MS;
  let settledAll = true;
  while (settledAll && state.queue.length > 0 && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time, each from the head of the queue.
    settledAll = await writeHead(state);
  }
  if (state.queue.length > 0) {
    logger.warn("StorageBase audit events not flushed at shutdown", { route: ROUTE, unsent: state.queue.length });
  }
}

/** The ring's events, oldest first: what the admin fallback reads when no store answered. */
export function storagebaseBufferedAuditEvents(): StoragebaseAuditEvent[] {
  return [...sinkState().ring];
}

/** Test seam: forgets the queue, the ring, their counters and the timer, as a new process would. */
export function resetStoragebaseAuditSinkForTests(): void {
  const holder = globalThis as SinkHolder;
  sinkTimers().clearTimeout(holder[SINK_KEY]?.timer);
  delete holder[SINK_KEY];
}
