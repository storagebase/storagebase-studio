import { registerAuditSink, type AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getForkStore } from "./index";

/**
 * The durable audit destination (StorageBase fork): every emitted event is appended to the fork
 * store's `storagebase_audit_events` table, so a pod restart no longer wipes the trail the admin
 * UI reads. It is the THIRD destination, after the ring buffer and the authoritative stdout line,
 * and deliberately the weakest: the append runs after the request has been answered, and a
 * failure is logged, never raised.
 *
 * The log is rate-limited to one line per STORE_FAILURE_LOG_INTERVAL_MS: a dead storage database
 * fails every append, and a line per event would bury the log the stdout audit channel shares.
 */

export const STORE_FAILURE_LOG_INTERVAL_MS = 60_000;

let lastFailureLoggedAt = Number.NEGATIVE_INFINITY;
let suppressedFailures = 0;

function reportFailure(error: unknown, now: number): void {
  if (now - lastFailureLoggedAt < STORE_FAILURE_LOG_INTERVAL_MS) {
    suppressedFailures++;
    return;
  }
  logger.error("Failed to append audit event to the durable store", error, {
    store: "fork-store",
    suppressedSinceLastReport: suppressedFailures,
  });
  lastFailureLoggedAt = now;
  suppressedFailures = 0;
}

export async function appendToDurableStore(event: AuditEvent, now: () => number = Date.now): Promise<void> {
  try {
    const store = await getForkStore();
    await store?.appendAuditEvent(event);
  } catch (error) {
    reportFailure(error, now());
  }
}

const INSTALLED_KEY = Symbol.for("storagebase.durableAuditSink");

/**
 * Registers the durable sink once per process. Idempotent; a no-op cost when storage is local.
 * Returns the function that removes it again (tests; nothing in the app uninstalls it).
 */
export function installDurableAuditSink(): () => void {
  const holder = globalThis as { [INSTALLED_KEY]?: () => void };
  if (!holder[INSTALLED_KEY]) {
    const unregister = registerAuditSink((event) => appendToDurableStore(event));
    holder[INSTALLED_KEY] = () => {
      unregister();
      delete holder[INSTALLED_KEY];
    };
  }
  return holder[INSTALLED_KEY];
}

/** Forgets the rate limiter's state. For tests. */
export function resetDurableAuditSinkForTests(): void {
  lastFailureLoggedAt = Number.NEGATIVE_INFINITY;
  suppressedFailures = 0;
}
