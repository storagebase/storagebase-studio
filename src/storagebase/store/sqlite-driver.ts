import { DEFAULT_STORAGE_SQLITE_PATH } from "@/lib/data-dir";
import { storagebaseTimers } from "@/storagebase/core/timers";
import type { SqlDriver } from "./sql-store";

/**
 * The SQLite driver for the fork store (StorageBase fork): the same file STORAGE_PROVIDER=sqlite
 * already uses (STORAGE_SQLITE_PATH, defaulting exactly as the upstream provider does), opened
 * through better-sqlite3 as a second handle. WAL mode, which the upstream provider turns on,
 * lets the two handles share the file; the busy timeout covers the moments both write.
 *
 * The handle is held only while the store works: it is opened by a statement and released at the
 * next macrotask once no statement follows (a flush's batch of appends runs on microtasks, so it
 * shares one open). A handle held for the life of the process outlived the upstream storage
 * provider's own close, which on Windows is a database file nobody can move and a test temp
 * directory whose teardown fails with EBUSY.
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

/** A driver over a handle `open` makes on demand and releases once idle (see the module docblock). */
function idleClosingDriver(open: () => SqliteDatabaseLike): SqlDriver {
  let db: SqliteDatabaseLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    timer = undefined;
    db?.close(true);
    db = null;
  };
  const use = (): SqlDriver => {
    db ??= open();
    if (timer === undefined) {
      timer = storagebaseTimers().setTimeout(release, 0);
      // The idle close must never hold the process open on its own.
      timer.unref?.();
    }
    return sqliteDriver(db);
  };
  // Opened at once, so a file that cannot be opened fails the store's open rather than its first write.
  use();
  return {
    run: (sql, params) => use().run(sql, params),
    all: (sql, params) => use().all(sql, params),
    async close() {
      storagebaseTimers().clearTimeout(timer);
      release();
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
  return idleClosingDriver(() => {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    return db as unknown as SqliteDatabaseLike;
  });
}
