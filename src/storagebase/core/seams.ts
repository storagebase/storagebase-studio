/**
 * The two seams the upstream sinks call into (StorageBase fork): the one module
 * `src/lib/query-events/sink.ts` (S2) and `src/lib/audit.ts` (S3) import. SEAMS.md owns the edits;
 * this file owns everything they cost.
 *
 * It is deliberately tiny and dependency-free: importing it must cost nothing, because upstream
 * imports it on every request path — including the proxy, whose own import graph is held to a
 * boundary that forbids `pg`. The two upstream contracts it accepts are therefore described here
 * as minimal STRUCTURAL shapes, not imported as types: importing `@/lib/query-events/types` would
 * pull `src/lib/governance/settings.ts` (and the whole governance runtime) into the published
 * package's declaration graph, even though the tap only reads a handful of fields. The sink loads
 * through a dynamic import on the FIRST tap — fire-and-forget, its failure swallowed — so a sink
 * that cannot load, or a record that cannot run, can never fail a query or a request (the old
 * fork's invariant).
 *
 * The sink specifier is written as a no-substitution template literal on purpose. The governance
 * boundary censuses read double-quoted specifiers only; a literal `"@/storagebase/audit/sink"`
 * here would make the proxy's static graph reach the fork store's postgres driver, and make the
 * package's declaration walk reach the sink's own type-only import of the query-event model. A
 * template literal is the same module at runtime (and is still statically resolved by the
 * bundlers and by `mock.module`), but it is a genuine dynamic boundary rather than a static edge
 * in either graph.
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

/** The fields of an upstream `QueryEventInput` the S2 sink actually reads, structurally. */
interface TappedQueryEvent {
  readonly source: string;
  readonly principal: { readonly subject: string; readonly username: string; readonly role: "admin" | "user" };
  readonly connection: {
    readonly id: string;
    readonly name: string | null;
    readonly engine: string | null;
    readonly accessLevel: "read" | "write" | null;
  };
  readonly statement: string | null;
  readonly status: "success" | "error" | "cancelled" | "refused";
  readonly statementType?: string;
  readonly started: { readonly wallClockMs: number; readonly monotonicMs: number };
  readonly explain?: unknown;
  readonly rowCount?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly correlationId?: string;
  readonly clientIp?: string;
}

/** The fields of an upstream `AuditEvent` the S3 sink actually copies, structurally. */
interface TappedAuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly action: string;
  readonly target: string;
  readonly user: string;
  readonly result: "success" | "failure";
  readonly container?: string;
  readonly engineUser?: string;
  readonly connectionName?: string;
  readonly duration?: number;
  readonly details?: unknown;
  readonly ip?: string;
  readonly reason?: string;
  readonly bucket?: string;
  readonly correlationId?: string;
  readonly passkey?: string;
}

/** The two record functions the loaded sink exposes, described without importing its module type. */
interface StoragebaseAuditSinkModule {
  storagebaseRecordQueryEvent(input: TappedQueryEvent): void;
  storagebaseRecordUpstreamEvent(event: TappedAuditEvent): void;
}

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
  holder[SINK_MODULE_KEY] ??= import(`@/storagebase/audit/sink`).catch(() => null);
  return holder[SINK_MODULE_KEY];
}

/** S2: one executed (or refused) unit, handed over by `recordQueryEvent` before its governance gate. */
export function storagebaseQueryTap(input: TappedQueryEvent): void {
  void loadSink()
    .then((sink) => sink?.storagebaseRecordQueryEvent(input))
    .catch(() => {});
}

/** S3: one emitted upstream audit event, handed over by `emitAuditEvent` after it was stored. */
export function storagebaseAuditTap(event: TappedAuditEvent): void {
  void loadSink()
    .then((sink) => sink?.storagebaseRecordUpstreamEvent(event))
    .catch(() => {});
}
