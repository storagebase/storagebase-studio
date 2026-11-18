import type { AuditEvent } from "@/lib/audit";
import type { StoragebaseAuditEvent } from "./types";

/**
 * An upstream audit event, converted to the fork's schema (StorageBase fork). This is what the S3
 * tap stores: every login, logout, role denial, rate limit, agent and MCP operation upstream's own
 * `emitAuditEvent` recorded, reaching the fork's durable store so a pod restart no longer wipes the
 * trail the fork admin page reads.
 *
 * The conversion is a COPY, field for field, of everything upstream's `AuditEvent` carries onto the
 * fork schema's same-named base fields - nothing upstream recorded is dropped, and no field is
 * re-derived (a second evaluation of what the event said could disagree with the first). The fork's
 * extended fields stay unset: upstream events carry no statement, engine or request context of
 * their own, and the fork never invents one.
 *
 * The upstream event's `id` and `timestamp` are kept, so the fork's stdout line and durable row are
 * joinable with the upstream `libredb.audit.v1` line by id.
 */
export function storagebaseEventFromUpstream(event: AuditEvent): StoragebaseAuditEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    action: event.action,
    target: event.target,
    ...(event.container !== undefined ? { container: event.container } : {}),
    ...(event.engineUser !== undefined ? { engineUser: event.engineUser } : {}),
    ...(event.connectionName !== undefined ? { connectionName: event.connectionName } : {}),
    user: event.user,
    result: event.result,
    ...(event.duration !== undefined ? { duration: event.duration } : {}),
    ...(event.details !== undefined ? { details: event.details } : {}),
    ...(event.ip !== undefined ? { ip: event.ip } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.bucket !== undefined ? { bucket: event.bucket } : {}),
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
    ...(event.passkey !== undefined ? { passkey: event.passkey } : {}),
  };
}
