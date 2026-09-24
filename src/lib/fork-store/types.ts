import type { AuditEvent } from "@/lib/audit";

/**
 * The fork's own durable server-side tables (StorageBase fork): the audit trail and the settings
 * the fork adds. It lives beside the upstream storage layer rather than inside it — the upstream
 * `user_storage` table is a per-user key/value of client collections, and neither an append-only
 * event log nor an operator-wide setting is either of those.
 */

export interface AuditEventQuery {
  /** Inclusive ISO-8601 bounds on the event timestamp. */
  from?: string;
  to?: string;
  /** Exact matches. */
  type?: string;
  action?: string;
  result?: string;
  /** The connection type (`AuditEvent.engine`), exact. */
  engine?: string;
  /** Case-insensitive substring matches. `ip` also matches the forwarded chain. */
  user?: string;
  ip?: string;
  /** Case-insensitive substring over action, target, connection, statement, error, details, engine, user. */
  text?: string;
  /** Page size, clamped to 1..MAX_AUDIT_PAGE_SIZE. */
  limit: number;
  /** The previous page's `nextCursor`. Pages run newest first. */
  cursor?: string;
}

export interface AuditEventPage {
  events: AuditEvent[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export interface ForkStore {
  appendAuditEvent(event: AuditEvent): Promise<void>;
  queryAuditEvents(query: AuditEventQuery): Promise<AuditEventPage>;
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T, actor: string): Promise<void>;
}

/** The largest page any caller gets, whatever it asks for. */
export const MAX_AUDIT_PAGE_SIZE = 1000;

/** A refusal that is the caller's fault (a cursor it did not get from us). */
export class AuditQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditQueryError";
  }
}
