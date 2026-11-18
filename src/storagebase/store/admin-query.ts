import { getServerAuditBuffer, type AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getForkStore } from "./index";
import { pageAuditEvents } from "./query";
import { storagebaseEventFromUpstream } from "@/storagebase/audit/upstream";
import { storagebaseBufferedAuditEvents } from "@/storagebase/audit/sink";
import type { StoragebaseAuditEvent } from "@/storagebase/audit/types";
import { AuditQueryError, MAX_AUDIT_PAGE_SIZE, type AuditEventPage, type AuditEventQuery } from "./types";

/**
 * The fork admin audit read (StorageBase fork): the durable store when the deployment has one,
 * the buffered events otherwise — and the buffer too when the store cannot answer, because an
 * operator investigating an incident is better served by the last events than by a 500. `source`
 * says which one answered, so the UI can say whether the trail survives restarts.
 *
 * The buffered fallback is the union of the two rings that hold different events: the fork sink's
 * ring (query events and, in phase 2, resource events — upstream's buffer never sees them) and
 * upstream's own ring (login, logout, role denials, admin actions), each event converted to the
 * fork schema. The two sets are disjoint by construction, so no event appears twice.
 */

/** The filter names the request body may carry, beside `limit` and `export`. */
const FILTER_FIELDS = ["from", "to", "type", "action", "user", "ip", "result", "text", "engine", "cursor"] as const;

const DEFAULT_PAGE_SIZE = 100;

/** The export's bound: it pages through the source, but never past this many rows. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** What the request body asked for: the query, and whether it asked for the export. */
export interface AuditReadRequest {
  query: AuditEventQuery;
  export: boolean;
}

export function readAuditRequest(body: Record<string, unknown>): AuditReadRequest {
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.trunc(body.limit) : NaN;
  const query: AuditEventQuery = {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PAGE_SIZE,
  };
  for (const name of FILTER_FIELDS) {
    const value = body[name];
    if (typeof value === "string" && value.trim() !== "") query[name] = value.trim();
  }
  return { query, export: body.export === true };
}

export interface AuditPageResponse extends AuditEventPage {
  source: "store" | "buffer";
}

export async function readAuditPage(
  query: AuditEventQuery,
  buffered: readonly StoragebaseAuditEvent[],
): Promise<AuditPageResponse> {
  try {
    const store = await getForkStore();
    if (store) return { ...(await store.queryAuditEvents(query)), source: "store" };
  } catch (error) {
    // A malformed cursor is the caller's mistake and is answered as one, from either source.
    if (error instanceof AuditQueryError) throw error;
    logger.error("The durable audit store could not answer; serving the buffered events", error, {
      store: "fork-store",
    });
  }
  return { ...pageAuditEvents(buffered, query), source: "buffer" };
}

/**
 * Every matching event, not just one page: the export pages through whichever source answered, one
 * MAX_AUDIT_PAGE_SIZE page at a time, and never past AUDIT_EXPORT_MAX_ROWS.
 */
export async function readAuditExport(
  query: AuditEventQuery,
  buffered: readonly StoragebaseAuditEvent[],
): Promise<{ events: StoragebaseAuditEvent[]; source: "store" | "buffer" }> {
  const events: StoragebaseAuditEvent[] = [];
  let cursor: string | undefined;
  let source: "store" | "buffer" = "buffer";
  while (events.length < AUDIT_EXPORT_MAX_ROWS) {
    const page = await readAuditPage({ ...query, limit: MAX_AUDIT_PAGE_SIZE, cursor }, buffered);
    source = page.source;
    events.push(...page.events);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { events: events.slice(0, AUDIT_EXPORT_MAX_ROWS), source };
}

/**
 * The buffered events the fallback serves: the fork sink's ring, then every upstream ring event
 * converted to the fork schema.
 */
export function bufferedAuditEvents(): StoragebaseAuditEvent[] {
  const upstream: readonly AuditEvent[] = getServerAuditBuffer().getAll();
  return [...storagebaseBufferedAuditEvents(), ...upstream.map(storagebaseEventFromUpstream)];
}
