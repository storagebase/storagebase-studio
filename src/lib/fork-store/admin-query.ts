import type { AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getForkStore } from "./index";
import { pageAuditEvents } from "./query";
import type { AuditEventPage, AuditEventQuery } from "./types";

/**
 * GET /api/admin/audit's reading (StorageBase fork): the durable store when the deployment has
 * one, the in-process ring buffer otherwise — and the buffer too when the store cannot answer,
 * because an operator investigating an incident is better served by the last 1000 events than by
 * a 500. `source` says which one answered, so the UI can say whether the trail survives restarts.
 */

const FILTER_PARAMS = ["from", "to", "type", "action", "user", "ip", "result", "text", "engine", "cursor"] as const;
const DEFAULT_PAGE_SIZE = 100;

export function readAuditQuery(params: URLSearchParams): AuditEventQuery {
  const query: AuditEventQuery = { limit: Number.parseInt(params.get("limit") ?? "", 10) || DEFAULT_PAGE_SIZE };
  for (const name of FILTER_PARAMS) {
    const value = params.get(name)?.trim();
    if (value) query[name] = value;
  }
  return query;
}

export interface AuditPageResponse extends AuditEventPage {
  source: "store" | "buffer";
}

export async function readAuditPage(
  query: AuditEventQuery,
  buffered: readonly AuditEvent[],
): Promise<AuditPageResponse> {
  try {
    const store = await getForkStore();
    if (store) return { ...(await store.queryAuditEvents(query)), source: "store" };
  } catch (error) {
    // A malformed cursor is the caller's mistake and is answered as one, from either source.
    if (error instanceof Error && error.name === "AuditQueryError") throw error;
    logger.error("The durable audit store could not answer; serving the in-memory buffer", error, {
      store: "fork-store",
    });
  }
  return { ...pageAuditEvents(buffered, query), source: "buffer" };
}
