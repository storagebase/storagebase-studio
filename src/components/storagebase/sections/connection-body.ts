import {
  isSeededResourceConnection,
  type ResourceConnection,
  type ResourceConnectionRow,
} from "@/storagebase/resources/types";

/**
 * What a section page holds for its active connection: a browser row from the
 * connections catalog (ids, non-secret fields, a has-credential marker) or an
 * unsaved candidate the form is still building (which carries the typed
 * credential once, for the test route).
 *
 * The fork never holds a stored connection's secret in the browser, so the two
 * halves of the union are named by ID, never inlined. An unsaved candidate has
 * no server record yet, so its one inline trip is the exception.
 */
export type SectionConnection = ResourceConnection | ResourceConnectionRow;

/** The stored-connection id namespace; a `seed:` id is the other one (the seed file owns those). */
const STORED_ID_PREFIX = "res_";

/**
 * How a section names a connection in a fork resource route's body. Fork
 * routes resolve ids on the server: a seeded row's id already carries `seed:`
 * and a stored row's is the minted `res_…` id. Everything else is the form's
 * pre-save candidate and travels inline — credentials and all — so it can be
 * probed before it is ever sealed into the store.
 */
export function sectionConnectionBody(conn: SectionConnection): Record<string, unknown> {
  return isSeededResourceConnection(conn) || conn.id.startsWith(STORED_ID_PREFIX)
    ? { connectionId: conn.id }
    : { connection: conn };
}
