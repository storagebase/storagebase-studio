import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { storagebaseRequestContext } from "./request-context";
import { recordStoragebaseAuditEvent } from "./sink";
import type { StoragebaseAuditCounts, StoragebaseAuditEventInput } from "./types";
import {
  ResourceConflictError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
  ResourceRouteError,
} from "@/storagebase/resources/errors";

/**
 * The audit shape for every fork resource action (StorageBase fork, ported from the old fork's
 * src/lib/api/resource-audit.ts).
 *
 * WRITES emit one event for the guard decision and, when allowed, one for the provider's outcome,
 * joined by one correlation id — the `agent_operation` / `object_edit` shape, so an operator can
 * tell who decided from what happened (`beginResourceWrite` / `endResourceWrite`).
 *
 * READS emit exactly one event with the outcome (`auditedResourceRead`): a tree listing, a blob
 * preview, download or metadata read, a message browse, a health or meta probe, and every Kafka
 * inspection. They used to emit nothing on the rule that a read changes nothing; for a console
 * whose objects are buckets, queues and vaults, "who looked at what" is the question the trail
 * exists to answer, so every action is on it now.
 *
 * What an event may carry is narrow by construction: the ADDRESS of the action (bucket/key, vault
 * path or secret name, topic and seek position, group id) in `target`, the connection's id, name
 * and type, the caller's request context, and a few numeric `counts`. Never a value, a body, a
 * message payload or secret material: the read helper records what `details` returns only after the
 * sink's sanitizer has reduced it to numbers and booleans.
 *
 * The events are FORK events (`resource_operation`, a type upstream's closed union does not
 * declare — P3), recorded through the fork's sink, not through upstream's `emitAuditEvent`.
 *
 * Every emit is isolated: a broken sink must not turn an action into a 500, and it must not
 * swallow the action's own error either.
 */

/** The connection a resource action ran against, for the audit event's connection fields. */
export interface ResourceAuditConnection {
  readonly id: string;
  readonly name: string | null;
  readonly type: string;
}

/** What a fork resource route knows about the caller and the connection it acts on. */
export interface ResourceRequestContext {
  readonly session: { readonly role: string; readonly username?: string };
  readonly route: string;
  readonly connection?: ResourceAuditConnection;
}

/** The closed reason vocabulary for a resource action's failure. */
type ResourceAuditReason =
  | "resource_unsupported"
  | "resource_not_found"
  | "resource_conflict"
  | "resource_invalid_request"
  | "resource_failed";

function reasonForResourceError(error: unknown): ResourceAuditReason {
  if (error instanceof ResourceOperationUnsupportedError) return "resource_unsupported";
  if (error instanceof ResourceNotFoundError) return "resource_not_found";
  if (error instanceof ResourceConflictError) return "resource_conflict";
  if (error instanceof ResourceInvalidRequestError || error instanceof ResourceRouteError) {
    return "resource_invalid_request";
  }
  return "resource_failed";
}

/** The connection's id, name and type, or none when the route passed no connection. */
function connectionFields(connection: ResourceAuditConnection | undefined): Partial<StoragebaseAuditEventInput> {
  if (connection === undefined) return {};
  return {
    connectionId: connection.id,
    ...(connection.name !== null ? { connectionName: connection.name } : {}),
    engine: connection.type,
  };
}

/**
 * Emits the decision event; returns the correlation id the outcome joins. `request` and
 * `connection` are optional so a route that passes them gets the caller's address, forwarded
 * chain and user agent, and the connection's id, name and type.
 */
export function beginResourceWrite(
  user: string,
  action: string,
  target: string,
  request?: { headers: Headers },
  connection?: ResourceAuditConnection,
): string {
  // randomUUID, the server-side precedent (upstream's execution.ts): correlation ids are opaque
  // execution keys, never secrets.
  const correlationId = randomUUID();
  try {
    recordStoragebaseAuditEvent({
      type: "resource_operation",
      action,
      target,
      user,
      result: "success",
      correlationId,
      ...(request ? storagebaseRequestContext(request) : {}),
      ...connectionFields(connection),
    });
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
  request?: { headers: Headers },
  connection?: ResourceAuditConnection,
): void {
  try {
    recordStoragebaseAuditEvent({
      type: "resource_operation",
      action,
      target,
      user,
      result: error === null ? "success" : "failure",
      ...(error === null ? {} : { reason: reasonForResourceError(error) }),
      correlationId,
      ...(request ? storagebaseRequestContext(request) : {}),
      ...connectionFields(connection),
    });
  } catch (auditError) {
    logger.error("Failed to record resource_operation outcome", auditError, { action });
  }
}

/**
 * Runs one resource READ and records it: one `resource_operation` event, success or failure, with
 * the caller (user, role, address, forwarded chain, user agent), the connection, the `target`
 * address, the wall-clock duration and — on success — whatever small counts `details` derives
 * from the result (`{ itemsListed: page.nodes.length }`). The result itself is returned untouched
 * and never recorded; the action's error is rethrown untouched after its failure event.
 *
 * `details` runs inside the isolation too: a counting bug is logged, never turned into a failed
 * read.
 */
export async function auditedResourceRead<T>(
  ctx: ResourceRequestContext,
  request: { headers: Headers },
  action: string,
  target: string,
  run: () => Promise<T>,
  details?: (result: T) => StoragebaseAuditCounts,
): Promise<T> {
  const startedAt = Date.now();
  const record = (
    outcome: Pick<StoragebaseAuditEventInput, "result" | "reason"> & { counts?: StoragebaseAuditCounts },
  ) => {
    try {
      recordStoragebaseAuditEvent({
        type: "resource_operation",
        action,
        target,
        user: ctx.session.username || ctx.session.role,
        role: ctx.session.role,
        ...storagebaseRequestContext(request),
        ...connectionFields(ctx.connection),
        duration: Date.now() - startedAt,
        ...outcome,
        ...(outcome.counts === undefined ? {} : { counts: outcome.counts }),
      });
    } catch (auditError) {
      logger.error("Failed to record resource_operation read", auditError, { action, route: ctx.route });
    }
  };

  let result: T;
  try {
    result = await run();
  } catch (error) {
    record({ result: "failure", reason: reasonForResourceError(error) });
    throw error;
  }

  let counts: StoragebaseAuditCounts | undefined;
  try {
    counts = details ? details(result) : undefined;
  } catch (countError) {
    logger.error("Failed to count resource_operation read", countError, { action, route: ctx.route });
  }
  record({ result: "success", ...(counts !== undefined ? { counts } : {}) });
  return result;
}
