import { auditRequestFields } from "@/lib/api/audit-request";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent, type AuditEvent, type AuditEventType, type AuditReason } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { accessAuditFields } from "./grant";
import { sessionActor, sessionAuditFields, type SessionLike } from "./session";

/**
 * The access model's audit events (StorageBase fork). Every emit is isolated — a broken audit
 * sink must never change the outcome it records — and every DENIAL is metered on the `anon` bucket
 * keyed by the caller, the rule every other denial in this product follows: one session polling a
 * connection it cannot see must not fill the log or evict real events from the ring buffer.
 */

type RequestLike = { headers: Headers };

function emit(event: Omit<AuditEvent, "id" | "timestamp">): void {
  try {
    emitAuditEvent(event);
  } catch (auditError) {
    logger.error("Failed to record an access audit event", auditError, { type: event.type, action: event.action });
  }
}

/** A refused use of a managed connection: not granted (answered as not found), insufficient, or read-only. */
export function auditAccessDenial(opts: {
  session: SessionLike;
  target: string;
  reason: Extract<AuditReason, "access_not_granted" | "access_insufficient" | "access_read_only">;
  connection?: { id: string; name?: string; type?: string };
  request?: RequestLike;
}): void {
  const actor = sessionActor(opts.session);
  const notice = consumeRateLimit("anon", actor);
  if (!notice.allowed && !notice.tripped) return;
  emit({
    type: "permission_denied",
    action: "denied",
    target: opts.target,
    user: actor,
    role: opts.session.role,
    result: "failure",
    reason: opts.reason,
    ...sessionAuditFields(opts.session),
    ...(opts.request ? auditRequestFields(opts.request) : {}),
    ...(opts.connection
      ? { connectionId: opts.connection.id, connectionName: opts.connection.name, engine: opts.connection.type }
      : {}),
    ...accessAuditFields(opts.connection),
  });
}

/**
 * How long one caller's use of one managed connection is recorded once. Every ACTION on a managed
 * connection is already on the trail with its grant (query_execution, resource_operation); this
 * event is the one that also covers the routes that record nothing of their own — the catalog
 * browser, monitoring, health — without writing a line per poll.
 */
export const MANAGED_USE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_USES = 5000;
const lastUse = new Map<string, number>();

/** Test seam. */
export function resetManagedUseTracking(): void {
  lastUse.clear();
}

export function recordManagedUse(
  session: SessionLike,
  connection: { id: string; name: string; type: string },
  now = Date.now(),
): void {
  const actor = sessionActor(session);
  const key = `${actor}\u0000${connection.id}`;
  const previous = lastUse.get(key);
  if (previous !== undefined && now - previous < MANAGED_USE_WINDOW_MS) return;
  if (lastUse.size >= MAX_TRACKED_USES) lastUse.clear();
  lastUse.set(key, now);
  emit({
    type: "managed_connection",
    action: "connection.use",
    target: connection.id,
    user: actor,
    role: session.role,
    result: "success",
    ...sessionAuditFields(session),
    connectionId: connection.id,
    connectionName: connection.name,
    engine: connection.type,
    ...accessAuditFields(connection),
  });
}

/** An administrator's change to the access model or the sign-in switch, with the record before and after. */
export function auditAccessChange(opts: {
  request: RequestLike;
  session: SessionLike;
  type: Extract<AuditEventType, "access_config" | "managed_connection" | "auth_settings_changed">;
  action: string;
  target: string;
  details?: unknown;
  failed?: boolean;
}): void {
  emit({
    type: opts.type,
    action: opts.action,
    target: opts.target,
    user: sessionActor(opts.session),
    role: opts.session.role,
    result: opts.failed ? "failure" : "success",
    ...(opts.details === undefined ? {} : { details: JSON.stringify(opts.details) }),
    ...auditRequestFields(opts.request),
  });
}
