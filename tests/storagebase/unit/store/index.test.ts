import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteDriver, type SqliteDatabaseLike } from "@/storagebase/store/sqlite-driver";

/**
 * getForkStore: which storage backs it, one open per process, and retries after a failed open. Both
 * drivers are replaced by an in-memory `bun:sqlite` one, so what runs is the real store over a real
 * engine. The durable audit sink's own behaviour is tested in
 * tests/storagebase/unit/audit/sink.test.ts.
 */

const opens = { sqlite: 0, postgres: 0 };
let failNextOpen = false;

function memoryDriver() {
  if (failNextOpen) {
    failNextOpen = false;
    throw new Error("storage database unreachable");
  }
  return sqliteDriver(new Database(":memory:") as unknown as SqliteDatabaseLike);
}

mock.module("@/storagebase/store/sqlite-driver", () => ({
  sqliteDriver,
  openSqliteDriver: async () => {
    opens.sqlite++;
    return memoryDriver();
  },
}));
mock.module("@/storagebase/store/postgres-driver", () => ({
  openPostgresDriver: async () => {
    opens.postgres++;
    return memoryDriver();
  },
}));

const { getForkStore, closeForkStore, readAuditRetentionDays, DEFAULT_AUDIT_RETENTION_DAYS } = await import(
  "@/storagebase/store"
);

const savedProvider = process.env.STORAGE_PROVIDER;

describe("getForkStore", () => {
  beforeEach(async () => {
    await closeForkStore();
    opens.sqlite = 0;
    opens.postgres = 0;
    failNextOpen = false;
  });

  afterEach(async () => {
    await closeForkStore();
    if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = savedProvider;
  });

  test("is null when storage is browser-local", async () => {
    delete process.env.STORAGE_PROVIDER;
    expect(await getForkStore()).toBeNull();
    process.env.STORAGE_PROVIDER = "local";
    expect(await getForkStore()).toBeNull();
  });

  test("opens the configured engine once per process, even for concurrent first callers", async () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    const [a, b] = await Promise.all([getForkStore(), getForkStore()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(opens).toEqual({ sqlite: 1, postgres: 0 });

    await closeForkStore();
    process.env.STORAGE_PROVIDER = "postgres";
    await getForkStore();
    expect(opens.postgres).toBe(1);
  });

  test("a failed open is not memoized: the next call retries", async () => {
    process.env.STORAGE_PROVIDER = "sqlite";
    failNextOpen = true;
    await expect(getForkStore()).rejects.toThrow("storage database unreachable");
    expect(await getForkStore()).not.toBeNull();
    expect(opens.sqlite).toBe(2);
  });

  test("closing with nothing open, or after a failed open, is harmless", async () => {
    await closeForkStore();
    process.env.STORAGE_PROVIDER = "sqlite";
    failNextOpen = true;
    const failed = expect(getForkStore()).rejects.toThrow();
    await expect(closeForkStore()).resolves.toBeUndefined();
    await failed;
  });
});

describe("readAuditRetentionDays", () => {
  test("reads whole days, 0 included, and falls back to the default otherwise", () => {
    expect(readAuditRetentionDays(undefined)).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(readAuditRetentionDays("90")).toBe(90);
    expect(readAuditRetentionDays(" 0 ")).toBe(0);
    expect(readAuditRetentionDays("-1")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(readAuditRetentionDays("a year")).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(readAuditRetentionDays("9999999")).toBe(36500);
  });

  test("the store it opens carries the retention the env names", async () => {
    const saved = process.env.STORAGEBASE_AUDIT_RETENTION_DAYS;
    process.env.STORAGEBASE_AUDIT_RETENTION_DAYS = "0";
    process.env.STORAGE_PROVIDER = "sqlite";
    try {
      const store = await getForkStore();
      expect(store).not.toBeNull();
      // A retention of 0 keeps everything, so the oldest event survives a prune.
      await store!.appendAuditEvent({
        id: "ancient",
        timestamp: "2000-01-01T00:00:00.000Z",
        type: "logout",
        action: "logout",
        target: "POST /api/auth/logout",
        user: "alice",
        result: "success",
      });
      expect((await store!.queryAuditEvents({ limit: 10 })).events.map((event) => event.id)).toEqual(["ancient"]);
    } finally {
      await closeForkStore();
      if (saved === undefined) delete process.env.STORAGEBASE_AUDIT_RETENTION_DAYS;
      else process.env.STORAGEBASE_AUDIT_RETENTION_DAYS = saved;
    }
  });
});
