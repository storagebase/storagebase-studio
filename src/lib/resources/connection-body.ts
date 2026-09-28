import { isServerHeld, userConnectionId } from "@/lib/user-connections/ids";
import { isManagedResourceConnection, type ResourceConnection } from "./types";

/**
 * How a resource request names its connection — the one place every UI caller
 * builds it (tree, meta, test, health and the blob, message, Kafka and vault
 * routes all spread it into their body).
 *
 * An admin-managed connection reaches the browser without its credentials, so it
 * is named by id (`managed:<id>`) and resolved, permission-checked and decrypted
 * on the server (src/lib/api/resource-route.ts). A user's own connection saved
 * while the deployment has server storage is held the same way, write-only, and
 * named `user:<id>` (src/lib/user-connections). Only a connection the browser
 * itself holds — STORAGE_PROVIDER=local, or one the embedding host passes in —
 * travels inline, credentials and all; keeping the choice here is what lets that
 * switch happen in one function rather than at every call site.
 */
export function resourceConnectionBody(
  conn: ResourceConnection,
): { connection: ResourceConnection } | { connectionId: string } {
  if (isManagedResourceConnection(conn)) return { connectionId: conn.id };
  if (isServerHeld(conn)) return { connectionId: userConnectionId(conn.id) };
  return { connection: conn };
}
