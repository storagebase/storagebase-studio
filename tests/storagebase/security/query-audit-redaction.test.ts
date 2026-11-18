import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  flushStoragebaseAuditEvents,
  storagebaseBufferedAuditEvents,
  resetStoragebaseAuditSinkForTests,
} from "@/storagebase/audit/sink";
import { closeForkStore } from "@/storagebase/store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/storagebase/store/sqlite-driver";
import type { QueryEventInput } from "@/lib/query-events/types";

/**
 * Threat: a value a user queried with reaching the fork audit trail. The S2 seam hands the fork
 * every `QueryEventInput` — statement and error included — and the trail the seam writes to has
 * two destinations: the durable `storagebase_audit_events` row and the `storagebase.audit.v1`
 * stdout line. Neither may carry a literal or a credential: the masker replaces every literal
 * with `?` before the text becomes a field, and the error text is masked the same way, because a
 * driver echoes the offending value back. A broken sink must never turn the query into a failure
 * either: the tap is fire-and-forget, and this file drives it through the real `recordQueryEvent`
 * (the seam line, before the governance gate) with the store failing and stdout failing in turn.
 *
 * The masker's own cases are unit-tested one by one (tests/storagebase/unit/audit/masker.test.ts);
 * this file proves the whole path. `getForkStore` runs for real over a mocked in-memory SQLite
 * driver, so the durable rows are real store SQL.
 */

const SECRET = "s3cr3t";
const PASSWORD = "hunter2-db-password";

const memory = new Database(":memory:");
mock.module("@/storagebase/store/sqlite-driver", () => ({
  sqliteDriver,
  openSqliteDriver: async () => sqliteDriver(memory as unknown as SqliteDatabaseLike),
}));

// The sink is loaded up front, as it is in a running process after the first tap: the seam's
// lazy FIRST load (a real module load on a real event-loop turn) is covered by
// tests/storagebase/unit/core/seams.test.ts; here the steady state is what the redaction
// assertions run against, so the tap's dynamic import resolves from the cache in a microtask.
await import("@/storagebase/audit/sink");

const { recordQueryEvent } = await import("@/lib/query-events/sink");

const savedProvider = process.env.STORAGE_PROVIDER;
// Migrated once, through the store itself (the driver mock answers), so the table every case
// reads and cleans exists before the first case runs.
process.env.STORAGE_PROVIDER = "sqlite";
await (await import("@/storagebase/store")).getForkStore();

let logSpy: ReturnType<typeof spyOn>;

function queryInput(statement: string | null, type: string): QueryEventInput {
  // The input model (src/lib/query-events/types.ts) carries no credential field at all, so no
  // credential can reach the trail through it; what it does carry is copied only by name.
  return {
    source: "editor",
    principal: { subject: "sub-1", username: "alice", role: "user" },
    connection: {
      id: "seed:orders",
      name: "Orders DB",
      engine: type as QueryEventInput["connection"]["engine"],
      accessLevel: "read",
    },
    statement,
    status: "success",
    started: { wallClockMs: Date.now(), monotonicMs: 0 },
    rowCount: 1,
    clientIp: "203.0.113.9",
  };
}

/** Lets the tap's fire-and-forget chain land, then drains both destinations at once: the
 * shutdown-style flush prints and writes everything queued, whatever timer set this process's
 * sink ended up pinned to (the seams module pins the real pair when it loaded first). */
async function flushedTrail(): Promise<{ rows: string; lines: string[] }> {
  for (let i = 0; i < 3000; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round lets the work the one before it started run.
    await Promise.resolve();
  }
  await flushStoragebaseAuditEvents();
  const rows = JSON.stringify(memory.prepare("SELECT * FROM storagebase_audit_events").all());
  const lines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  return { rows, lines };
}

function expectNothingLeaked(destination: string): void {
  expect(destination).not.toContain(SECRET);
  expect(destination).not.toContain(PASSWORD);
  expect(destination).not.toContain("postgres://");
}

beforeEach(() => {
  resetStoragebaseAuditSinkForTests();
  process.env.STORAGE_PROVIDER = "sqlite";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  memory.prepare("DELETE FROM storagebase_audit_events").run();
});

afterEach(() => {
  logSpy.mockRestore();
  resetStoragebaseAuditSinkForTests();
  memory.prepare("DELETE FROM storagebase_audit_events").run();
});

afterAll(async () => {
  await closeForkStore();
  if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
  else process.env.STORAGE_PROVIDER = savedProvider;
});

describe("a query_execution event never carries a literal or a credential", () => {
  test("a SQL string literal, in either destination", async () => {
    expect(() =>
      recordQueryEvent(queryInput(`SELECT * FROM users WHERE password = '${SECRET}'`, "postgres")),
    ).not.toThrow();
    const { rows, lines } = await flushedTrail();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      schema: "storagebase.audit.v1",
      event: "query_execution",
      statement: "SELECT * FROM users WHERE password = ?",
    });
    for (const destination of [rows, lines.join("\n")]) expectNothingLeaked(destination);
    expect(JSON.stringify(storagebaseBufferedAuditEvents())).not.toContain(SECRET);
  });

  test("a literal hidden in a comment, a dollar quote and an escaped quote", async () => {
    recordQueryEvent(
      queryInput(`SELECT 1 /* ${SECRET} */, $$${SECRET}$$, 'it''s ${SECRET}' -- ${SECRET}\nFROM t`, "postgres"),
    );
    const { rows, lines } = await flushedTrail();
    expect(lines).toHaveLength(1);
    for (const destination of [rows, lines.join("\n")]) expectNothingLeaked(destination);
  });

  test("a driver error that echoes the literal back", async () => {
    const input = {
      ...queryInput(`SELECT * FROM t WHERE id = '${SECRET}'`, "postgres"),
      status: "error",
      errorCode: "22P02",
      errorMessage: `invalid input syntax for type integer: "${SECRET}"`,
    } as QueryEventInput;
    recordQueryEvent(input);
    const { rows, lines } = await flushedTrail();
    expect(JSON.parse(lines[0]).error).toBe("invalid input syntax for type integer: ?");
    for (const destination of [rows, lines.join("\n")]) expectNothingLeaked(destination);
  });

  test("a MongoDB filter value", async () => {
    recordQueryEvent(
      queryInput(JSON.stringify({ collection: "users", operation: "find", filter: { pw: SECRET } }), "mongodb"),
    );
    const { rows, lines } = await flushedTrail();
    for (const destination of [rows, lines.join("\n")]) expectNothingLeaked(destination);
  });

  test("a Redis command argument, key included", async () => {
    recordQueryEvent(queryInput(`SET token:${SECRET} "${SECRET}"`, "redis"));
    const { rows, lines } = await flushedTrail();
    expect(JSON.parse(lines[0]).statement).toBe("SET ? ?");
    for (const destination of [rows, lines.join("\n")]) expectNothingLeaked(destination);
  });

  test("a broken stdout never fails the query, and the durable row still lands", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("stdout gone");
    });
    expect(() => recordQueryEvent(queryInput(`SELECT '${SECRET}'`, "postgres"))).not.toThrow();
    await flushedTrail();
    const rows = JSON.stringify(memory.prepare("SELECT * FROM storagebase_audit_events").all());
    expectNothingLeaked(rows);
  });

  test("a store that cannot be opened never fails the query; the line is still written", async () => {
    delete process.env.STORAGE_PROVIDER;
    expect(() => recordQueryEvent(queryInput(`SELECT '${SECRET}'`, "postgres"))).not.toThrow();
    const { lines } = await flushedTrail();
    expect(lines).toHaveLength(1);
    expectNothingLeaked(lines.join("\n"));
  });
});
