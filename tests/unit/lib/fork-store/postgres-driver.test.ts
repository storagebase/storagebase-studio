import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { logger } from "@/lib/logger";

/**
 * The fork store's PostgreSQL driver, with `pg` mocked the way the upstream storage provider's
 * suite mocks it (tests/unit/lib/storage/providers/postgres.test.ts): no PostgreSQL runs in
 * `bun run test`. The SQL itself is exercised against a real SQLite engine in sql-store.test.ts;
 * what is pinned here is what differs for PostgreSQL — the placeholder rewrite, the pool config
 * (TLS decided by the upstream provider's own reading of the URL) and the pool error guard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = mock(async (..._args: any[]): Promise<any> => ({ rows: [{ value: "1" }] }));
const mockEnd = mock(async () => {});
let lastPool: EventEmitter & Record<string, any>;
const mockPoolConstructor = mock((_config: any) => {
  lastPool = Object.assign(new EventEmitter(), { query: mockQuery, end: mockEnd });
  return lastPool;
});
mock.module("pg", () => ({ Pool: mockPoolConstructor }));
/* eslint-enable @typescript-eslint/no-explicit-any */

const { openPostgresDriver, toPgPlaceholders } = await import("@/lib/fork-store/postgres-driver");

describe("the fork store's PostgreSQL driver", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockEnd.mockClear();
    mockPoolConstructor.mockClear();
  });

  test("rewrites ? placeholders to $n in order", () => {
    expect(toPgPlaceholders("SELECT a FROM t WHERE b = ? AND (c < ? OR d = ?) LIMIT ?")).toBe(
      "SELECT a FROM t WHERE b = $1 AND (c < $2 OR d = $3) LIMIT $4",
    );
  });

  test("opens a small pool on STORAGE_POSTGRES_URL with the storage layer's TLS decision", async () => {
    const saved = process.env.STORAGE_POSTGRES_URL;
    process.env.STORAGE_POSTGRES_URL = "postgresql://app@db.internal:5432/app?sslmode=require";
    try {
      await openPostgresDriver();
      expect(mockPoolConstructor.mock.calls[0]?.[0]).toMatchObject({
        connectionString: "postgresql://app@db.internal:5432/app?sslmode=require",
        max: 2,
        ssl: { rejectUnauthorized: false },
      });
    } finally {
      if (saved === undefined) delete process.env.STORAGE_POSTGRES_URL;
      else process.env.STORAGE_POSTGRES_URL = saved;
    }
    await openPostgresDriver("postgresql://localhost:5432/app");
    expect(mockPoolConstructor.mock.calls[1]?.[0]).toMatchObject({ ssl: false });
  });

  test("refuses to open without a URL", async () => {
    const saved = process.env.STORAGE_POSTGRES_URL;
    delete process.env.STORAGE_POSTGRES_URL;
    try {
      await expect(openPostgresDriver()).rejects.toThrow("STORAGE_POSTGRES_URL is required");
    } finally {
      if (saved !== undefined) process.env.STORAGE_POSTGRES_URL = saved;
    }
  });

  test("runs and queries with rewritten placeholders, and closes the pool", async () => {
    const driver = await openPostgresDriver("postgresql://localhost:5432/app");
    await driver.run("DELETE FROM t WHERE ts < ?", ["x"]);
    await driver.run("SELECT 1");
    const rows = await driver.all<{ value: string }>("SELECT value FROM s WHERE key = ?", ["k"]);
    await driver.all("SELECT 2");
    await driver.close();

    expect(mockQuery.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["DELETE FROM t WHERE ts < $1", ["x"]],
      ["SELECT 1", []],
      ["SELECT value FROM s WHERE key = $1", ["k"]],
      ["SELECT 2", []],
    ]);
    expect(rows).toEqual([{ value: "1" }]);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test("an idle client error on the pool is logged, not thrown", async () => {
    await openPostgresDriver("postgresql://localhost:5432/app");
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(() => lastPool.emit("error", new Error("terminated"))).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
