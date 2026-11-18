import { isSeededResourceConnection, type ResourceConnection } from "./types";

/**
 * How a resource request names its connection — the one place every UI caller
 * builds it (tree, meta, test, health and the phase 3-4 family routes all
 * spread it into their body).
 *
 * Every connection the fork serves is server-held: a seeded one from the fork
 * seed file, a user-created one from the fork store. The browser therefore
 * names one by id (`{ connectionId }`) and the server resolves, checks and
 * decrypts it (src/storagebase/resources/handle-request.ts) — a seeded row's
 * id is already `seed:<id>`, a stored row's the minted `res_…` id. Only a
 * connection the browser itself holds in full — the pre-save candidate the
 * connection form is still editing, tested before it is ever stored — travels
 * inline, credentials and all; keeping the choice here is what lets that
 * switch happen in one function rather than at every call site.
 */
export function resourceConnectionBody(
  conn: ResourceConnection,
): { connection: ResourceConnection } | { connectionId: string } {
  if (isSeededResourceConnection(conn)) return { connectionId: conn.id };
  return { connection: conn };
}
