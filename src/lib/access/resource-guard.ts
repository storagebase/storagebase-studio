import type { ResourceConnection } from "@/lib/resources/types";
import { auditAccessDenial } from "./audit";
import { AccessDeniedError } from "./errors";
import { grantOf } from "./grant";
import { permits } from "./permissions";
import { resourceRoutePermission } from "./resource-permissions";
import type { SessionLike } from "./session";

/**
 * The resource layer's enforcement (StorageBase fork): refuses a resource route unless the grant a
 * managed connection was resolved with covers what the route needs (src/lib/access/resource-permissions.ts).
 * A user-owned connection carries no grant and passes untouched.
 */
export function requireResourcePermission(
  request: { headers: Headers },
  session: SessionLike,
  connection: ResourceConnection,
  route: string,
): void {
  const grant = grantOf(connection);
  if (!grant) return;
  const required = resourceRoutePermission(route);
  if (permits(grant.permission, required)) return;
  auditAccessDenial({ session, target: `POST /${route}`, reason: "access_insufficient", connection, request });
  throw new AccessDeniedError(`Your access to "${connection.name}" is ${grant.permission}; this needs ${required}.`);
}
