import type { AuditEvent } from "@/lib/audit";
import { AuditQueryError, MAX_AUDIT_PAGE_SIZE, type AuditEventPage, type AuditEventQuery } from "./types";

/**
 * One reading of an audit query, shared by the durable store's SQL and the ring-buffer fallback,
 * so the admin API answers the same filter the same way whichever source serves it.
 *
 * Order is newest first, by (timestamp, id): timestamps are ISO-8601 UTC strings, which sort
 * lexicographically in time order in both SQLite and PostgreSQL, and the id breaks ties between
 * events emitted in the same millisecond. A cursor is the (timestamp, id) of the last event of
 * the previous page, opaque to the caller.
 */

interface CursorPosition {
  ts: string;
  id: string;
}

export function encodeCursor(event: Pick<AuditEvent, "timestamp" | "id">): string {
  return Buffer.from(JSON.stringify([event.timestamp, event.id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === "string")) {
      return { ts: parsed[0], id: parsed[1] };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new AuditQueryError("Invalid audit cursor");
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_AUDIT_PAGE_SIZE);
}

/** The lower-cased text the free-text filter searches. */
export function searchTextOf(event: AuditEvent): string {
  return [
    event.action,
    event.target,
    event.connectionName,
    event.statement,
    event.error,
    event.details,
    event.engine,
    event.user,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase();
}

/** The lower-cased text the address filter searches: the resolved address and the forwarded chain. */
export function addressTextOf(event: AuditEvent): string {
  return [event.ip, event.forwardedFor]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase();
}

/** A LIKE pattern matching `needle` anywhere, with LIKE's own metacharacters escaped (ESCAPE '\'). */
export function containsPattern(needle: string): string {
  return `%${needle.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The WHERE clauses of a query, with `?` placeholders in parameter order. The column names are
 * the store's (src/lib/fork-store/sql-store.ts).
 */
export function buildAuditWhere(query: AuditEventQuery): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (clause: string, ...values: string[]) => {
    clauses.push(clause);
    params.push(...values);
  };

  if (query.from) add("ts >= ?", query.from);
  if (query.to) add("ts <= ?", query.to);
  if (query.type) add("type = ?", query.type);
  if (query.action) add("action = ?", query.action);
  if (query.result) add("result = ?", query.result);
  if (query.engine) add("engine = ?", query.engine);
  if (query.user) add("user_text LIKE ? ESCAPE '\\'", containsPattern(query.user));
  if (query.ip) add("address_text LIKE ? ESCAPE '\\'", containsPattern(query.ip));
  if (query.text) add("search_text LIKE ? ESCAPE '\\'", containsPattern(query.text));
  if (query.cursor) {
    const position = decodeCursor(query.cursor);
    add("(ts < ? OR (ts = ? AND id < ?))", position.ts, position.ts, position.id);
  }
  return { clauses, params };
}

/** The in-memory reading of one query's filters, for the ring-buffer fallback. */
function matches(event: AuditEvent, query: AuditEventQuery, position: CursorPosition | null): boolean {
  const contains = (haystack: string, needle: string | undefined) => !needle || haystack.includes(needle.toLowerCase());
  return (
    (!query.from || event.timestamp >= query.from) &&
    (!query.to || event.timestamp <= query.to) &&
    (!query.type || event.type === query.type) &&
    (!query.action || event.action === query.action) &&
    (!query.result || event.result === query.result) &&
    (!query.engine || event.engine === query.engine) &&
    contains(event.user.toLowerCase(), query.user) &&
    contains(addressTextOf(event), query.ip) &&
    contains(searchTextOf(event), query.text) &&
    (position === null || event.timestamp < position.ts || (event.timestamp === position.ts && event.id < position.id))
  );
}

function newestFirst(a: AuditEvent, b: AuditEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** One page of `events` under `query`, newest first — what the store answers, from memory. */
export function pageAuditEvents(events: readonly AuditEvent[], query: AuditEventQuery): AuditEventPage {
  const limit = clampLimit(query.limit);
  const position = query.cursor ? decodeCursor(query.cursor) : null;
  const matching = events.filter((event) => matches(event, query, position)).sort(newestFirst);
  const page = matching.slice(0, limit);
  return { events: page, nextCursor: matching.length > limit ? encodeCursor(page[page.length - 1]) : null };
}
