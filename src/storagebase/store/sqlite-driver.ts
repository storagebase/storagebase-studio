import { DEFAULT_STORAGE_SQLITE_PATH } from "@/lib/data-dir";
import type { SqlDriver } from "./sql-store";

/**
 * The SQLite driver for the fork store (StorageBase fork): the same file STORAGE_PROVIDER=sqlite
 * already uses (STORAGE_SQLITE_PATH, defaulting exactly as the upstream provider does), opened
 * through better-sqlite3 as a second handle. WAL mode, which the upstream provider turns on,
 * lets the two handles share the file; the busy timeout covers the moments both write.
 *
 * The handle lives for ONE statement: opened, used and closed inside the same synchronous call
 * (better-sqlite3 is synchronous), so it is never open across an await and nothing that awaits
 * the store, or anything else, can observe it. A handle held for the life of the process outlived
 * the upstream storage provider's own close, which on Windows is a database file nobody can move
 * and a test temp directory whose teardown fails with EBUSY; one released a macrotask later still
 * left a gap a teardown could land in. An open costs about 2 ms, and the store's statements are
 * few: an append per audit event, a handful per admin page.
 *
 * The statement surface is the one better-sqlite3 and `bun:sqlite` share (`prepare().run/all`,
 * `exec`, `close`), so the store's SQL is tested against a real SQLite engine in `bun test`.
 */

export interface SqliteDatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  /**
   * `true` is bun:sqlite's "release the file NOW" (it finalizes the statements a bare close would
   * leave as a zombie connection, see src/lib/db/providers/sql/sqlite-driver.ts); better-sqlite3
   * closes for real either way and ignores the argument.
   */
  close(throwOnError?: boolean): unknown;
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
      db.close(true);
    },
  };
}

/** A driver that opens a handle per statement and closes it before returning (see the module docblock). */
function perStatementDriver(open: () => SqliteDatabaseLike): SqlDriver {
  const once = <T>(statement: (driver: SqlDriver) => Promise<T>): Promise<T> => {
    const db = open();
    // better-sqlite3 runs the statement synchronously inside `statement`, so the close below follows it
    // in the same call; the promise only carries the already-settled result.
    const result = statement(sqliteDriver(db));
    db.close(true);
    return result;
  };
  // Opened (and closed) at once, so a file that cannot be opened fails the store's open rather
  // than its first write.
  open().close(true);
  return {
    run: (sql, params) => once((driver) => driver.run(sql, params)),
    all: (sql, params) => once((driver) => driver.all(sql, params)),
    async close() {},
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
  return perStatementDriver(() => {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    return db as unknown as SqliteDatabaseLike;
  });
}
