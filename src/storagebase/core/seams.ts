import type { AuditEvent } from "@/lib/audit";
import type { QueryEventInput } from "@/lib/query-events/types";

/**
 * The two seams the upstream sinks call into (StorageBase fork): the one module
 * `src/lib/query-events/sink.ts` (S2) and `src/lib/audit.ts` (S3) import. SEAMS.md owns the edits;
 * this file owns everything they cost.
 *
 * It is deliberately tiny and dependency-free except the two TYPE imports: importing it must cost
 * nothing, because upstream imports it on every request path. The sink loads through a dynamic
 * import on the FIRST tap — fire-and-forget, its failure swallowed — so a sink that cannot load,
 * or a record that cannot run, can never fail a query or a request (the old fork's invariant).
 *
 * The loaded module is memoized on globalThis under a registered symbol, once per process,
 * because the routes that tap and the bundles that load them are separately compiled entries.
 *
 * This module also PINS the process's timers at its own load, under a second registered symbol:
 * the sink schedules its flush with the pinned pair rather than `globalThis.setTimeout`, so a
 * later-installed fake clock (bun's `jest.useFakeTimers()`, which upstream's own sink test uses to
 * prove it leaves no timer behind) can never capture the fork's flush. Upstream code imports this
 * module at its load, before any test body runs, which is what makes the pinned pair the real one.
 */
type StoragebaseAuditSinkModule = typeof import("@/storagebase/audit/sink");

const SINK_MODULE_KEY = Symbol.for("storagebase.auditSinkModule");
const PINNED_TIMERS_KEY = Symbol.for("storagebase.auditTimers");

type SinkModuleHolder = { [SINK_MODULE_KEY]?: Promise<StoragebaseAuditSinkModule | null> };
type PinnedTimersHolder = {
  [PINNED_TIMERS_KEY]?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
};

(globalThis as PinnedTimersHolder)[PINNED_TIMERS_KEY] ??= { setTimeout, clearTimeout };

/** The sink module, loaded once per process; null when it could not be loaded. */
function loadSink(): Promise<StoragebaseAuditSinkModule | null> {
  const holder = globalThis as SinkModuleHolder;
  holder[SINK_MODULE_KEY] ??= import("@/storagebase/audit/sink").catch(() => null);
  return holder[SINK_MODULE_KEY];
}

/** S2: one executed (or refused) unit, handed over by `recordQueryEvent` before its governance gate. */
export function storagebaseQueryTap(input: QueryEventInput): void {
  void loadSink()
    .then((sink) => sink?.storagebaseRecordQueryEvent(input))
    .catch(() => {});
}

/** S3: one emitted upstream audit event, handed over by `emitAuditEvent` after it was stored. */
export function storagebaseAuditTap(event: AuditEvent): void {
  void loadSink()
    .then((sink) => sink?.storagebaseRecordUpstreamEvent(event))
    .catch(() => {});
}
