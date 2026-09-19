import { randomUUID } from "node:crypto";
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ResourceNotFoundError, ResourceOperationUnsupportedError } from "@/lib/resources/errors";

/**
 * The audit shape for resource writes (StorageBase fork): one event for the
 * guard decision and, when allowed, one for the provider's outcome, joined by
 * one correlation id — the `agent_operation` / `object_edit` shape, so an
 * operator can tell who decided from what happened. Reads (meta, tree,
 * health, test, preview, download) emit nothing: like object reads, they
 * change nothing.
 *
 * Both emits are isolated: a broken audit sink must not turn a write into a
 * 500 (the /api/resources/test precedent).
 */

function reasonForResourceWriteError(error: unknown): AuditReason {
  if (error instanceof ResourceOperationUnsupportedError) return "resource_unsupported";
  if (error instanceof ResourceNotFoundError) return "resource_not_found";
  return "resource_failed";
}

/** Emits the decision event; returns the correlation id the outcome joins. */
export function beginResourceWrite(user: string, action: string, target: string): string {
  // randomUUID, the server-side precedent (execution.ts): correlation ids are
  // opaque execution keys, never secrets, and the server has no secure-context
  // restriction to work around.
  const correlationId = randomUUID();
  try {
    emitAuditEvent({ type: "resource_operation", action, target, user, result: "success", correlationId });
  } catch (auditError) {
    logger.error("Failed to record resource_operation decision", auditError, { action });
  }
  return correlationId;
}

/** Emits the outcome event for a decided write. */
export function endResourceWrite(
  user: string,
  action: string,
  target: string,
  correlationId: string,
  error: unknown | null,
): void {
  try {
    emitAuditEvent({
      type: "resource_operation",
      action,
      target,
      user,
      result: error === null ? "success" : "failure",
      ...(error === null ? {} : { reason: reasonForResourceWriteError(error) }),
      correlationId,
    });
  } catch (auditError) {
    logger.error("Failed to record resource_operation outcome", auditError, { action });
  }
}
