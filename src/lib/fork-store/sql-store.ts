import type { AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { addressTextOf, buildAuditWhere, clampLimit, encodeCursor, searchTextOf } from "./query";
import type { AuditEventPage, AuditEventQuery, ForkStore } from "./types";

/**
 * The fork store's SQL, written once for both server storage engines (StorageBase fork).
 *
 * Every statement here is the common subset of SQLite and PostgreSQL: TEXT columns only,
 * `CREATE … IF NOT EXISTS`, `INSERT … ON CONFLICT … DO NOTHING / DO UPDATE`, and `?`
 * placeholders that the PostgreSQL driver rewrites to `$n`. Timestamps are stored as the
 * ISO-8601 UTC strings the audit module already mints, which order correctly as text in both
 * engines, so one query shape serves both without a dialect branch.
 */

export interface SqlDriver {
  /** Runs a statement that returns no rows. `?` placeholders. */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /** Runs a query. `?` placeholders. */
  all<Row>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

const FORK_STORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS storagebase_audit_events (
    id           TEXT PRIMARY KEY,
    ts           TEXT NOT NULL,
    type         TEXT NOT NULL,
    action       TEXT NOT NULL,
    result       TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    user_text    TEXT NOT NULL,
    engine       TEXT,
    address_text TEXT NOT NULL,
    search_text  TEXT NOT NULL,
    event        TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS storagebase_audit_events_ts ON storagebase_audit_events (ts)",
  "CREATE INDEX IF NOT EXISTS storagebase_audit_events_type_ts ON storagebase_audit_events (type, ts)",
  "CREATE INDEX IF NOT EXISTS storagebase_audit_events_user_ts ON storagebase_audit_events (user_name, ts)",
  `CREATE TABLE IF NOT EXISTS storagebase_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`,
];

/** How often, at most, an append also prunes events past retention. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SqlForkStoreOptions {
  /** Days an event is kept; 0 keeps every event. */
  retentionDays: number;
  /** The clock, injectable so retention is testable without waiting a year. */
  now?: () => number;
}

export class SqlForkStore implements ForkStore {
  private lastPrunedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(
    private readonly driver: SqlDriver,
    private readonly options: SqlForkStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Creates the tables and indexes; safe to run on every boot. */
  async migrate(): Promise<void> {
    for (const statement of FORK_STORE_SCHEMA) await this.driver.run(statement);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.driver.run(
      `INSERT INTO storagebase_audit_events
         (id, ts, type, action, result, user_name, user_text, engine, address_text, search_text, event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.timestamp,
        event.type,
        event.action,
        event.result,
        event.user,
        event.user.toLowerCase(),
        event.engine ?? null,
        addressTextOf(event),
        searchTextOf(event),
        JSON.stringify(event),
      ],
    );
    await this.pruneIfDue();
  }

  async queryAuditEvents(query: AuditEventQuery): Promise<AuditEventPage> {
    const limit = clampLimit(query.limit);
    const { clauses, params } = buildAuditWhere(query);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.driver.all<{ event: string }>(
      `SELECT event FROM storagebase_audit_events ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const events: AuditEvent[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        events.push(JSON.parse(row.event) as AuditEvent);
      } catch {
        logger.warn("Skipping a corrupted audit row", { store: "fork-store" });
      }
    }
    const last = events[events.length - 1];
    return { events, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const rows = await this.driver.all<{ value: string }>("SELECT value FROM storagebase_settings WHERE key = ?", [
      key,
    ]);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value) as T;
    } catch {
      logger.warn("Corrupted fork setting", { store: "fork-store", key });
      return null;
    }
  }

  async setSetting<T>(key: string, value: T, actor: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO storagebase_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [key, JSON.stringify(value), new Date(this.now()).toISOString(), actor],
    );
  }

  /** Deletes every event older than the retention window, now. */
  async prune(): Promise<void> {
    this.lastPrunedAt = this.now();
    if (this.options.retentionDays <= 0) return;
    const cutoff = new Date(this.now() - this.options.retentionDays * DAY_MS).toISOString();
    await this.driver.run("DELETE FROM storagebase_audit_events WHERE ts < ?", [cutoff]);
  }

  /** Retention is lazy: at most one prune per PRUNE_INTERVAL_MS, riding on an append. */
  private async pruneIfDue(): Promise<void> {
    if (this.now() - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    await this.prune();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
