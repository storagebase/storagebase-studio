import { getSeedConnectionById } from "@/lib/seed";
import { ResourceNotFoundError } from "@/lib/resources/errors";
import { parseUserConnectionId } from "@/lib/user-connections/ids";
import { resolveUserConnection } from "@/lib/user-connections/server";
import type { DatabaseConnection } from "@/lib/types";
import { resolveManagedDatabaseSeed } from "./resolve";
import { sessionRoles, type SessionLike } from "./session";

/**
 * The one call `resolveConnection` (src/lib/seed/resolve-connection.ts, upstream territory) makes
 * into the access model (StorageBase fork), so the upstream file carries one changed line:
 *
 * - an admin-managed `m_` seed resolves through the role bindings (src/lib/access/resolve.ts);
 * - any other seed id is a Helm seed, resolved exactly as upstream does, except that its `roles:`
 *   list is matched against the session's app roles as well as its Studio role.
 *
 * Null for both "not there" and "not for you", which the upstream caller then tells apart the way it
 * always has for Helm seeds (403 when the seed exists) and cannot tell apart for managed ones (404),
 * so a non-member learns nothing about a managed connection.
 */
export async function resolveSeedForSession(seedId: string, session: SessionLike): Promise<DatabaseConnection | null> {
  return (
    (await resolveManagedDatabaseSeed(seedId, session)) ?? (await getSeedConnectionById(seedId, sessionRoles(session)))
  );
}

/**
 * The second call `resolveConnection` makes into the fork: `user:<id>`, the caller's own connection
 * whose credentials the server holds (src/lib/user-connections). Null for any other id, so the
 * upstream path carries on exactly as before; an unknown `user:` id — including another user's —
 * is answered 404 here, the same answer, so it tells the caller nothing.
 */
export async function resolveOwnedConnection(
  connectionId: string,
  session: SessionLike,
): Promise<DatabaseConnection | null> {
  if (parseUserConnectionId(connectionId) === null) return null;
  const owned = await resolveUserConnection(session.username, "database", connectionId);
  if (!owned) throw new ResourceNotFoundError("Connection not found");
  return owned as unknown as DatabaseConnection;
}
