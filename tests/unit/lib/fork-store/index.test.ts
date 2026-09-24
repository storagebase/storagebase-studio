import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteDriver, type SqliteDatabaseLike } from "@/lib/fork-store/sqlite-driver";

/**
 * getForkStore: which storage backs it, one open per process, retries after a failed open, and the
 * durable audit sink that feeds it. Both drivers are replaced by an in-memory `bun:sqlite` one, so
 * what runs is the real store over a real engine.
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

mock.module("@/lib/fork-store/sqlite-driver", () => ({
  sqliteDriver,
  openSqliteDriver: async () => {
    opens.sqlite++;
    return memoryDriver();
  },
}));
mock.module("@/lib/fork-store/postgres-driver", () => ({
  openPostgresDriver: async () => {
    opens.postgres++;
    return memoryDriver();
  },
}));

const { getForkStore, closeForkStore, readAuditRetentionDays, DEFAULT_AUDIT_RETENTION_DAYS } = await import(
  "@/lib/fork-store"
);
const { appendToDurableStore, installDurableAuditSink, resetDurableAuditSinkForTests, STORE_FAILURE_LOG_INTERVAL_MS } =
  await import("@/lib/fork-store/audit-sink");
const { emitAuditEvent, getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

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
});

describe("the durable audit sink", () => {
  beforeEach(async () => {
    await closeForkStore();
    resetDurableAuditSinkForTests();
    getServerAuditBuffer().clear();
    process.env.STORAGE_PROVIDER = "sqlite";
  });

  afterEach(async () => {
    await closeForkStore();
    if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = savedProvider;
  });

  test("once installed, every emitted event is appended to the store, after the two other channels", async () => {
    const uninstall = installDurableAuditSink();
    expect(installDurableAuditSink()).toBe(uninstall);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const emitted = emitAuditEvent({
        type: "logout",
        action: "logout",
        target: "POST /api/auth/logout",
        user: "alice",
        result: "success",
      });
      const store = await getForkStore();
      let page = await store!.queryAuditEvents({ limit: 10 });
      for (let i = 0; i < 50 && page.events.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        page = await store!.queryAuditEvents({ limit: 10 });
      }
      expect(page.events).toEqual([emitted]);
    } finally {
      log.mockRestore();
      uninstall();
    }
    expect(installDurableAuditSink()).not.toBe(uninstall);
    installDurableAuditSink()();
  });

  test("a store failure is logged once per interval, never thrown", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    let now = 1_000_000;
    try {
      failNextOpen = true;
      await appendToDurableStore(
        { id: "1", timestamp: "t", type: "logout", action: "a", target: "t", user: "u", result: "success" },
        () => now,
      );
      failNextOpen = true;
      now += 1;
      await appendToDurableStore(
        { id: "2", timestamp: "t", type: "logout", action: "a", target: "t", user: "u", result: "success" },
        () => now,
      );
      expect(logged).toHaveBeenCalledTimes(1);

      failNextOpen = true;
      now += STORE_FAILURE_LOG_INTERVAL_MS;
      await appendToDurableStore(
        { id: "3", timestamp: "t", type: "logout", action: "a", target: "t", user: "u", result: "success" },
        () => now,
      );
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged.mock.calls[1]?.[2]).toMatchObject({ suppressedSinceLastReport: 1 });
    } finally {
      logged.mockRestore();
    }
  });

  test("with local storage the sink appends nowhere and reports nothing", async () => {
    process.env.STORAGE_PROVIDER = "local";
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await appendToDurableStore({
        id: "1",
        timestamp: "t",
        type: "logout",
        action: "a",
        target: "t",
        user: "u",
        result: "success",
      });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
