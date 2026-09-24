import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { SqlForkStore, PRUNE_INTERVAL_MS } from "@/lib/fork-store/sql-store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/lib/fork-store/sqlite-driver";
import { encodeCursor } from "@/lib/fork-store/query";

/**
 * The fork store's SQL against a REAL SQLite engine, on a temp file: `bun:sqlite` stands in for
 * better-sqlite3 (which bun cannot load) through the statement surface the two share, so the
 * schema, the filters, the paging and the retention are executed, not asserted as strings.
 */

const DAY = 24 * 60 * 60 * 1000;

function event(overrides: Partial<AuditEvent> & Pick<AuditEvent, "id" | "timestamp">): AuditEvent {
  return {
    type: "resource_operation",
    action: "tree.list",
    target: "s3:/",
    user: "alice",
    result: "success",
    ...overrides,
  };
}

describe("SqlForkStore on SQLite", () => {
  let dir: string;
  let db: Database;
  let now: number;
  let store: SqlForkStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fork-store-"));
    db = new Database(join(dir, "storage.db"));
    now = Date.parse("2026-09-24T12:00:00.000Z");
    store = new SqlForkStore(sqliteDriver(db as unknown as SqliteDatabaseLike), {
      retentionDays: 30,
      now: () => now,
    });
    await store.migrate();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("migrating twice is harmless and creates both tables with their indexes", async () => {
    await store.migrate();
    const names = (db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "storagebase_audit_events",
        "storagebase_audit_events_ts",
        "storagebase_audit_events_type_ts",
        "storagebase_audit_events_user_ts",
        "storagebase_settings",
      ]),
    );
  });

  test("an appended event reads back whole, and a duplicate id is ignored", async () => {
    const stored = event({
      id: "e1",
      timestamp: "2026-09-24T11:00:00.000Z",
      counts: { itemsListed: 3 },
      engine: "s3",
    });
    await store.appendAuditEvent(stored);
    await store.appendAuditEvent({ ...stored, action: "changed" });

    const page = await store.queryAuditEvents({ limit: 10 });
    expect(page).toEqual({ events: [stored], nextCursor: null });
  });

  test("pages run newest first and the cursor continues where the last page ended, ties broken by id", async () => {
    for (const [id, ts] of [
      ["a", "2026-09-24T10:00:00.000Z"],
      ["b", "2026-09-24T11:00:00.000Z"],
      ["c", "2026-09-24T11:00:00.000Z"],
      ["d", "2026-09-24T11:30:00.000Z"],
      ["e", "2026-09-24T09:00:00.000Z"],
    ]) {
      await store.appendAuditEvent(event({ id, timestamp: ts }));
    }

    const first = await store.queryAuditEvents({ limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["d", "c"]);
    const second = await store.queryAuditEvents({ limit: 2, cursor: first.nextCursor! });
    expect(second.events.map((e) => e.id)).toEqual(["b", "a"]);
    const third = await store.queryAuditEvents({ limit: 2, cursor: second.nextCursor! });
    expect(third).toEqual({ events: [expect.objectContaining({ id: "e" })], nextCursor: null });
  });

  test("filters: date range, type, action, result, engine exactly; user, ip and text as case-insensitive substrings", async () => {
    await store.appendAuditEvent(
      event({
        id: "q1",
        timestamp: "2026-09-24T08:00:00.000Z",
        type: "query_execution",
        action: "executed",
        user: "Alice",
        ip: "203.0.113.9",
        statement: "SELECT * FROM orders WHERE id = ?",
        engine: "postgres",
      }),
    );
    await store.appendAuditEvent(
      event({
        id: "r1",
        timestamp: "2026-09-24T09:00:00.000Z",
        action: "blob.download",
        target: "s3:bucket-a/report.csv",
        user: "bob",
        result: "failure",
        forwardedFor: "198.51.100.7, 10.0.0.1",
        engine: "s3",
      }),
    );
    const ids = async (query: Parameters<SqlForkStore["queryAuditEvents"]>[0]) =>
      (await store.queryAuditEvents(query)).events.map((e) => e.id);

    expect(await ids({ limit: 10, from: "2026-09-24T08:30:00.000Z" })).toEqual(["r1"]);
    expect(await ids({ limit: 10, to: "2026-09-24T08:30:00.000Z" })).toEqual(["q1"]);
    expect(await ids({ limit: 10, type: "query_execution" })).toEqual(["q1"]);
    expect(await ids({ limit: 10, action: "blob.download" })).toEqual(["r1"]);
    expect(await ids({ limit: 10, result: "failure" })).toEqual(["r1"]);
    expect(await ids({ limit: 10, engine: "postgres" })).toEqual(["q1"]);
    expect(await ids({ limit: 10, user: "ALI" })).toEqual(["q1"]);
    expect(await ids({ limit: 10, ip: "10.0.0.1" })).toEqual(["r1"]);
    expect(await ids({ limit: 10, text: "FROM ORDERS" })).toEqual(["q1"]);
    expect(await ids({ limit: 10, text: "report.csv" })).toEqual(["r1"]);
  });

  test("LIKE metacharacters in a filter match literally", async () => {
    await store.appendAuditEvent(event({ id: "p1", timestamp: "2026-09-24T08:00:00.000Z", target: "s3:a_b/100%" }));
    await store.appendAuditEvent(event({ id: "p2", timestamp: "2026-09-24T08:01:00.000Z", target: "s3:axb/1000" }));
    expect((await store.queryAuditEvents({ limit: 10, text: "a_b/100%" })).events.map((e) => e.id)).toEqual(["p1"]);
  });

  test("a corrupted row is skipped with a warning, not thrown", async () => {
    await store.appendAuditEvent(event({ id: "ok", timestamp: "2026-09-24T08:00:00.000Z" }));
    db.prepare("UPDATE storagebase_audit_events SET event = '{not json' WHERE id = 'ok'").run();
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect((await store.queryAuditEvents({ limit: 10 })).events).toEqual([]);
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });

  test("retention prunes on the first append and then at most once per interval", async () => {
    const old = event({ id: "old", timestamp: new Date(now - 40 * DAY).toISOString() });
    db.prepare(
      `INSERT INTO storagebase_audit_events (id, ts, type, action, result, user_name, user_text, engine,
         address_text, search_text, event) VALUES (?, ?, 'x', 'x', 'success', 'u', 'u', NULL, '', '', ?)`,
    ).run(old.id, old.timestamp, JSON.stringify(old));

    await store.appendAuditEvent(event({ id: "new", timestamp: new Date(now).toISOString() }));
    expect((await store.queryAuditEvents({ limit: 10 })).events.map((e) => e.id)).toEqual(["new"]);

    // Within the interval, an event that has since aged out stays until the next prune is due.
    const aging = event({ id: "aging", timestamp: new Date(now - 31 * DAY).toISOString() });
    await store.appendAuditEvent(aging);
    expect((await store.queryAuditEvents({ limit: 10 })).events.map((e) => e.id)).toEqual(["new", "aging"]);

    now += PRUNE_INTERVAL_MS;
    await store.appendAuditEvent(event({ id: "later", timestamp: new Date(now).toISOString() }));
    expect((await store.queryAuditEvents({ limit: 10 })).events.map((e) => e.id)).toEqual(["later", "new"]);
  });

  test("a retention of 0 keeps every event", async () => {
    const keepAll = new SqlForkStore(sqliteDriver(db as unknown as SqliteDatabaseLike), {
      retentionDays: 0,
      now: () => now,
    });
    await keepAll.appendAuditEvent(event({ id: "ancient", timestamp: "2000-01-01T00:00:00.000Z" }));
    await keepAll.prune();
    expect((await keepAll.queryAuditEvents({ limit: 10 })).events.map((e) => e.id)).toEqual(["ancient"]);
  });

  test("the page size is clamped, so a huge limit still pages", async () => {
    for (let i = 0; i < 3; i++) {
      await store.appendAuditEvent(event({ id: `n${i}`, timestamp: `2026-09-24T08:0${i}:00.000Z` }));
    }
    expect((await store.queryAuditEvents({ limit: 0 })).events).toHaveLength(1);
    expect((await store.queryAuditEvents({ limit: Number.NaN })).events).toHaveLength(3);
    expect((await store.queryAuditEvents({ limit: 1_000_000 })).events).toHaveLength(3);
  });

  test("a cursor that is not ours is refused", async () => {
    await expect(store.queryAuditEvents({ limit: 10, cursor: "not-a-cursor" })).rejects.toThrow("Invalid audit cursor");
    const shaped = Buffer.from(JSON.stringify([1, 2])).toString("base64url");
    await expect(store.queryAuditEvents({ limit: 10, cursor: shaped })).rejects.toThrow("Invalid audit cursor");
    const ours = encodeCursor({ timestamp: "2026-09-24T08:00:00.000Z", id: "x" });
    await expect(store.queryAuditEvents({ limit: 10, cursor: ours })).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });

  test("settings round-trip as JSON with who and when, and an absent key is null", async () => {
    expect(await store.getSetting("retention")).toBeNull();
    await store.setSetting("retention", { days: 90 }, "alice");
    now += 1000;
    await store.setSetting("retention", { days: 30 }, "bob");

    expect(await store.getSetting<{ days: number }>("retention")).toEqual({ days: 30 });
    const row = db.prepare("SELECT updated_at, updated_by FROM storagebase_settings WHERE key = 'retention'").get() as {
      updated_at: string;
      updated_by: string;
    };
    expect(row).toEqual({ updated_at: new Date(now).toISOString(), updated_by: "bob" });
  });

  test("a corrupted setting reads as null with a warning", async () => {
    db.prepare(
      "INSERT INTO storagebase_settings (key, value, updated_at, updated_by) VALUES ('bad', '{', 'x', 'y')",
    ).run();
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await store.getSetting("bad")).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });
});
