import { DEFAULT_STORAGE_SQLITE_PATH } from "@/lib/data-dir";
import type { SqlDriver } from "./sql-store";

/**
 * The SQLite driver for the fork store (StorageBase fork): the same file STORAGE_PROVIDER=sqlite
 * already uses (STORAGE_SQLITE_PATH, defaulting exactly as src/lib/storage/providers/sqlite.ts
 * does), opened through better-sqlite3 as a second handle. WAL mode, which the upstream provider
 * turns on, lets the two handles share the file; the busy timeout covers the moments both write.
 *
 * The statement surface is the one better-sqlite3 and `bun:sqlite` share (`prepare().run/all`,
 * `exec`, `close`), so the store's SQL is tested against a real SQLite engine in `bun test`, where
 * better-sqlite3 cannot load.
 */

export interface SqliteDatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): unknown;
}

export function sqliteDriver(db: SqliteDatabaseLike): SqlDriver {
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly unknown[] = []) {
      return db.prepare(sql).all(...params) as Row[];
    },
    async close() {
      db.close();
    },
  };
}

/** Opens the configured SQLite storage file for the fork store. */
export async function openSqliteDriver(dbPath?: string): Promise<SqlDriver> {
  const path = dbPath || process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH;
  const [{ default: Database }, { dirname }, { existsSync, mkdirSync }] = await Promise.all([
    import("better-sqlite3"),
    import("node:path"),
    import("node:fs"),
  ]);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return sqliteDriver(db as unknown as SqliteDatabaseLike);
}
