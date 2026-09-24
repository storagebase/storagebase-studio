import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Opening the fork store's SQLite handle. better-sqlite3 cannot load under bun, so it is mocked
 * here the way the upstream provider's suite mocks it; the SQL runs for real in sql-store.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const pragmas: string[] = [];
const opened: string[] = [];
const fakeDb = {
  pragma: (value: string) => pragmas.push(value),
  prepare: () => ({ run: () => undefined, all: () => [] }),
  exec: () => undefined,
  close: () => undefined,
};
mock.module("better-sqlite3", () => ({
  default: function Database(this: any, path: string) {
    opened.push(path);
    return fakeDb;
  },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

const { openSqliteDriver } = await import("@/lib/fork-store/sqlite-driver");
const { DEFAULT_STORAGE_SQLITE_PATH } = await import("@/lib/data-dir");

describe("openSqliteDriver", () => {
  beforeEach(() => {
    pragmas.length = 0;
    opened.length = 0;
  });

  test("opens the configured file, creating its directory, in WAL mode with a busy timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-sqlite-"));
    const saved = process.env.STORAGE_SQLITE_PATH;
    process.env.STORAGE_SQLITE_PATH = join(dir, "nested", "storage.db");
    try {
      const driver = await openSqliteDriver();
      expect(opened).toEqual([join(dir, "nested", "storage.db")]);
      expect(existsSync(join(dir, "nested"))).toBe(true);
      expect(pragmas).toEqual(["journal_mode = WAL", "busy_timeout = 5000"]);
      await driver.run("SELECT 1");
      expect(await driver.all("SELECT 1")).toEqual([]);
      await driver.close();
    } finally {
      if (saved === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit path wins, and the storage layer's default applies when nothing is set", async () => {
    const saved = process.env.STORAGE_SQLITE_PATH;
    delete process.env.STORAGE_SQLITE_PATH;
    // The default path's directory is relative to the working directory: leave it as found.
    const defaultDir = dirname(DEFAULT_STORAGE_SQLITE_PATH);
    const defaultDirExisted = existsSync(defaultDir);
    try {
      await openSqliteDriver();
      expect(opened.at(-1)).toBe(DEFAULT_STORAGE_SQLITE_PATH);
      const dir = mkdtempSync(join(tmpdir(), "fork-sqlite-"));
      await openSqliteDriver(join(dir, "x.db"));
      expect(opened.at(-1)).toBe(join(dir, "x.db"));
      rmSync(dir, { recursive: true, force: true });
    } finally {
      if (saved !== undefined) process.env.STORAGE_SQLITE_PATH = saved;
      if (!defaultDirExisted) rmSync(defaultDir, { recursive: true, force: true });
    }
  });
});
