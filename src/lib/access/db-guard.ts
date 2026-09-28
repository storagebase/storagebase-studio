import type { DatabaseConnection } from "@/lib/types";
import { auditAccessDenial } from "./audit";
import { AccessDeniedError, AccessReadOnlyError } from "./errors";
import { grantOf } from "./grant";
import { permits } from "./permissions";
import { readOnlyVerdict } from "./read-only";
import type { SessionLike } from "./session";
import type { AccessPermission } from "./types";

/**
 * The enforcement hooks the database routes call (StorageBase fork). The routes are upstream
 * territory, so each carries ONE line into this module right after `resolveConnection`, and every
 * rule lives here. A connection with no grant — user-owned, or a Helm seed — passes untouched: the
 * access model governs managed connections and nothing else.
 */

type RequestLike = { headers: Headers };

/** Refuses the route unless the caller's grant on this managed connection covers `required`. */
export function requireManagedPermission(
  request: RequestLike,
  session: SessionLike,
  connection: DatabaseConnection,
  required: AccessPermission,
  target: string,
): void {
  const grant = grantOf(connection);
  if (!grant || permits(grant.permission, required)) return;
  auditAccessDenial({ session, target, reason: "access_insufficient", connection, request });
  throw new AccessDeniedError(`Your access to "${connection.name}" is ${grant.permission}; this needs ${required}.`);
}

/**
 * Refuses a statement a `read` grant does not cover. `write` and `admin` grants run anything; a
 * missing or non-string statement is left to the route's own 400.
 */
export function assertManagedStatement(
  request: RequestLike,
  session: SessionLike,
  connection: DatabaseConnection,
  statement: unknown,
  target: string,
): void {
  const grant = grantOf(connection);
  if (!grant || grant.permission !== "read" || typeof statement !== "string") return;
  const verdict = readOnlyVerdict(statement, connection.type);
  if (verdict.readOnly) return;
  auditAccessDenial({ session, target, reason: "access_read_only", connection, request });
  throw new AccessReadOnlyError(`"${connection.name}" is read-only for you: ${verdict.reason}.`);
}
