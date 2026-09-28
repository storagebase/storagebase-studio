/**
 * How a browser names a connection whose credentials the server holds (StorageBase fork).
 *
 * Client-safe on purpose: the request-body helpers (`buildConnectionPayload`,
 * `resourceConnectionBody`) import this, so nothing here may reach the storage encryption.
 *
 * A connection the user saved while the deployment has server storage is kept on the server with
 * its secrets sealed and write-only, and the browser keeps the non-secret fields plus
 * `savedSecrets` — the list of secret paths the server holds, `[]` when it holds none. That field
 * is the marker: a connection that carries it is sent as `{ connectionId: "user:<id>" }` and the
 * server rebuilds it for the signed-in user, so no saved secret ever travels back.
 */

export const USER_CONNECTION_PREFIX = "user:";

/** The two connection families a user saves, by the collection that holds each. */
export type UserConnectionFamily = "database" | "resource";

/** Whether the server holds this connection (and so must be asked for it by reference). */
export function isServerHeld(conn: { savedSecrets?: unknown }): boolean {
  return Array.isArray(conn.savedSecrets);
}

export function userConnectionId(id: string): string {
  return `${USER_CONNECTION_PREFIX}${id}`;
}

/** The connection id inside a `user:<id>` reference, or null for any other id. */
export function parseUserConnectionId(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(USER_CONNECTION_PREFIX)) return null;
  const id = value.slice(USER_CONNECTION_PREFIX.length);
  return id.length > 0 ? id : null;
}
