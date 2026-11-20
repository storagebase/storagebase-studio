import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { resetShutdownHooks, runShutdownHooks } from "@/lib/shutdown";
import { SqlForkStore } from "@/storagebase/store/sql-store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/storagebase/store/sqlite-driver";
import type { ForkStore } from "@/storagebase/store/types";
import type { StoragebaseAuditEvent, StoragebaseAuditEventInput } from "@/storagebase/audit/types";

/**
 * The fork audit sink (StorageBase fork): `record…` is a synchronous sanitize-and-enqueue that
 * never throws; the stdout line and the durable row both ride the flush; a full queue drops the
 * newest; a failed write keeps the batch and backs off; the shutdown hook drains what is left.
 *
 * The store is mocked at the module boundary (`@/storagebase/store`), with the real SqlForkStore
 * over an in-memory `bun:sqlite` handed in for the durable rows, so what runs is the real store
 * SQL; the fake timers move the flush intervals the way upstream's own sink test does.
 */

let store: ForkStore | null = null;
let openError: Error | null = null;
mock.module("@/storagebase/store", () => ({
  getForkStore: async () => {
    if (openError) throw openError;
    return store;
  },
}));

const {
  MAX_AUDIT_COUNTS,
  STORAGEBASE_AUDIT_BATCH_ROWS,
  STORAGEBASE_AUDIT_QUEUE_CAPACITY,
  flushStoragebaseAuditEvents,
  recordStoragebaseAuditEvent,
  resetStoragebaseAuditSinkForTests,
  storagebaseAuditBackoffMs,
  storagebaseBufferedAuditEvents,
  storagebaseRecordQueryEvent,
  storagebaseRecordUpstreamEvent,
} = await import("@/storagebase/audit/sink");

/**
 * Enough microtask rounds for one flush's whole chain to settle: a batch insert appends its rows
 * one await at a time, and each await is a few rounds. Cheap — every round is a no-op microtask.
 */
const SETTLE_ROUNDS = 6000;

/** An event input with the base shape every recording path shares. */
function input(overrides: Partial<StoragebaseAuditEventInput> = {}): StoragebaseAuditEventInput {
  return {
    type: "resource_operation",
    action: "tree.list",
    target: "s3:/",
    user: "alice",
    result: "success",
    ...overrides,
  };
}

/** The upstream events the S3 tap hands over. */
function upstreamEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "up-1",
    timestamp: "2026-09-24T10:00:00.000Z",
    type: "logout",
    action: "logout",
    target: "POST /api/auth/logout",
    user: "alice",
    result: "success",
    ...overrides,
  };
}

/** Lets the microtasks of work already started settle. */
async function settle(rounds = SETTLE_ROUNDS): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round lets the work the one before it started run.
    await Promise.resolve();
  }
}

/** Lets the timers move `ms` on, then lets the flush they armed settle. */
async function elapse(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

/** The sink's stdout lines, parsed, of everything logged while `logSpy` was installed. */
function parsedLines(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

/** The stored row as the dynamic sweep sees it, for fields the schema does not declare. */
function asRecord(event: StoragebaseAuditEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

let logSpy: ReturnType<typeof spyOn>;

/** A real store over an in-memory SQLite engine, for the durable rows, with its tables made. */
async function memoryStore(): Promise<SqlForkStore> {
  const store = new SqlForkStore(sqliteDriver(new Database(":memory:") as unknown as SqliteDatabaseLike), {
    retentionDays: 0,
  });
  await store.migrate();
  return store;
}

/** Wraps `real` so `appendAuditEvent` refuses while `refuse` holds. */
function refusing(real: SqlForkStore, refuse: { value: boolean }): ForkStore {
  return {
    appendAuditEvent: async (event: StoragebaseAuditEvent) => {
      if (refuse.value) throw new Error("database down");
      return real.appendAuditEvent(event);
    },
    queryAuditEvents: real.queryAuditEvents.bind(real),
    listRecords: real.listRecords.bind(real),
    putRecord: real.putRecord.bind(real),
    deleteRecord: real.deleteRecord.bind(real),
  };
}

beforeEach(() => {
  resetShutdownHooks();
  resetStoragebaseAuditSinkForTests();
  jest.useFakeTimers();
  store = null;
  openError = null;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  resetStoragebaseAuditSinkForTests();
  resetShutdownHooks();
  jest.useRealTimers();
});

describe("recordStoragebaseAuditEvent", () => {
  test("mints an id and a timestamp, and one event reaches both destinations on the flush", async () => {
    const real = await memoryStore();
    store = real;

    recordStoragebaseAuditEvent(input({ connectionId: "res-1", engine: "s3" }));
    expect(parsedLines()).toEqual([]);

    await elapse(1000);
    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ schema: "storagebase.audit.v1", action: "tree.list", actor: "alice" });
    const stored = (await real.queryAuditEvents({ limit: 10 })).events;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "resource_operation", connectionId: "res-1", engine: "s3" });
    expect(stored[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof stored[0].timestamp).toBe("string");
    expect(storagebaseBufferedAuditEvents()).toEqual(stored);
  });

  test("a carried id and timestamp are kept, so an upstream line and its fork copy join on the id", async () => {
    recordStoragebaseAuditEvent({ ...input(), id: "up-9", timestamp: "2026-09-24T10:00:00.000Z" });
    await elapse(1000);
    expect((await storagebaseBufferedAuditEvents())[0]).toMatchObject({
      id: "up-9",
      timestamp: "2026-09-24T10:00:00.000Z",
    });
  });

  test("the S3 path converts the upstream event; the S2 path builds the query event", async () => {
    const real = await memoryStore();
    store = real;
    storagebaseRecordUpstreamEvent(upstreamEvent({ id: "up-7", user: "bob" }));
    storagebaseRecordQueryEvent({
      source: "editor",
      principal: { subject: "s", username: "alice", role: "user" },
      connection: { id: "c1", name: null, engine: "postgres", accessLevel: "read" },
      statement: "SELECT 'secret-value'",
      status: "success",
      started: { wallClockMs: Date.now(), monotonicMs: 0 },
    });
    await elapse(1000);
    // The ring holds fork events only: upstream's own ring already holds the upstream one, and the
    // admin fallback reads both, so ringing it here too would list every sign-in twice.
    const buffered = storagebaseBufferedAuditEvents();
    expect(buffered.map((event) => event.type)).toEqual(["query_execution"]);
    expect(buffered[0]).toMatchObject({ action: "executed", statement: "SELECT ?" });
    const stored = (await real.queryAuditEvents({ limit: 10 })).events;
    expect(stored.find((event) => event.id === "up-7")).toMatchObject({ type: "logout", user: "bob" });
  });

  test("an upstream event reaches the store but prints no second stdout line", async () => {
    // Upstream's emitAuditEvent already printed its `libredb.audit.v1` line for this event; a
    // `storagebase.audit.v1` echo would double every login in a log pipeline and land inside the
    // console.log windows upstream's own tests assert on.
    const real = await memoryStore();
    store = real;
    storagebaseRecordUpstreamEvent(upstreamEvent({ id: "up-8" }));
    recordStoragebaseAuditEvent(input());
    await elapse(1000);
    expect(parsedLines().map((line) => line.event)).toEqual(["resource_operation"]);
    const stored = (await real.queryAuditEvents({ limit: 10 })).events.map((event) => event.id);
    expect(stored).toContain("up-8");
    expect(stored).toHaveLength(2);
  });

  test("a batch-sized queue flushes at once, without waiting for the interval", async () => {
    const real = await memoryStore();
    store = real;
    for (let i = 0; i < STORAGEBASE_AUDIT_BATCH_ROWS; i += 1) {
      recordStoragebaseAuditEvent(input({ action: `tree.list.${i}` }));
    }
    await settle();
    expect(parsedLines()).toHaveLength(STORAGEBASE_AUDIT_BATCH_ROWS);
    expect(storagebaseBufferedAuditEvents()).toHaveLength(STORAGEBASE_AUDIT_BATCH_ROWS);
    expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(10);
  });

  test("with local storage the flush prints the lines and drains, and nothing is counted as dropped", async () => {
    store = null;
    recordStoragebaseAuditEvent(input());
    await elapse(1000);
    expect(parsedLines()).toHaveLength(1);
    expect(storagebaseBufferedAuditEvents()).toHaveLength(1);
    await flushStoragebaseAuditEvents();
    expect(parsedLines()).toHaveLength(1);
  });

  test("a full queue drops the newest event, counts it, and warns once per spell", async () => {
    store = null;
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < STORAGEBASE_AUDIT_QUEUE_CAPACITY + 2; i += 1) {
        recordStoragebaseAuditEvent(input({ action: `overflow.${i}` }));
      }
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]?.[1]).toMatchObject({ capacity: STORAGEBASE_AUDIT_QUEUE_CAPACITY });
      // The ring keeps the newest 1000 events, whatever the queue dropped.
      expect(storagebaseBufferedAuditEvents()).toHaveLength(1000);
      expect(storagebaseBufferedAuditEvents().at(-1)?.action).toBe("overflow.10001");
      await flushStoragebaseAuditEvents();
      expect(parsedLines()).toHaveLength(STORAGEBASE_AUDIT_QUEUE_CAPACITY);
    } finally {
      warned.mockRestore();
    }
  });

  test("an event that cannot be built or sanitized is logged, never thrown", () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const broken = input();
      Object.defineProperty(broken, "target", {
        enumerable: true,
        get() {
          throw new Error("getter exploded");
        },
      });
      expect(() => recordStoragebaseAuditEvent(broken)).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(storagebaseBufferedAuditEvents()).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("the stdout line", () => {
  test("carries every field a full event has, in the fork schema's shape", async () => {
    store = null;
    recordStoragebaseAuditEvent(
      input({
        role: "admin",
        details: "detail text",
        duration: 7,
        reason: "resource_failed",
        correlationId: "corr-1",
        connectionName: "Blob store",
        ip: "203.0.113.9",
        forwardedFor: "203.0.113.9, 10.0.0.1",
        userAgent: "curl/8.7.1",
        connectionId: "res-1",
        engine: "s3",
        host: "blob.example.com",
        database: "bucket-a",
        statementKind: "SELECT",
        statement: "SELECT ? FROM t",
        statementTruncated: true,
        rowsReturned: 3,
        rowsAffected: 4,
        error: "boom ?",
        queryId: "q-1",
        counts: { itemsListed: 3 },
        authProvider: "oidc",
        subject: "sub-9",
        appRoles: "reader",
        permission: "read",
        grantedBy: "admin-bypass",
        accessGroups: "group-a,group-b",
      }),
    );
    await elapse(1000);
    expect(parsedLines()).toEqual([
      expect.objectContaining({
        schema: "storagebase.audit.v1",
        event: "resource_operation",
        action: "tree.list",
        outcome: "success",
        actor: "alice",
        route: "s3:/",
        role: "admin",
        duration_ms: 7,
        reason: "resource_failed",
        correlation_id: "corr-1",
        connection: "Blob store",
        ip: "203.0.113.9",
        forwarded_for: "203.0.113.9, 10.0.0.1",
        user_agent: "curl/8.7.1",
        connection_id: "res-1",
        engine: "s3",
        host: "blob.example.com",
        database: "bucket-a",
        statement_kind: "SELECT",
        statement: "SELECT ? FROM t",
        statement_truncated: true,
        rows_returned: 3,
        rows_affected: 4,
        error: "boom ?",
        query_id: "q-1",
        counts: { itemsListed: 3 },
        auth_provider: "oidc",
        subject: "sub-9",
        app_roles: "reader",
        permission: "read",
        granted_by: "admin-bypass",
        access_groups: "group-a,group-b",
      }),
    ]);
  });

  test("carries the base fields only when the event carries none of the extended ones", async () => {
    store = null;
    recordStoragebaseAuditEvent(input());
    await elapse(1000);
    const [line] = parsedLines();
    expect(line).toEqual({
      schema: "storagebase.audit.v1",
      ts: expect.any(String),
      id: expect.any(String),
      event: "resource_operation",
      action: "tree.list",
      outcome: "success",
      actor: "alice",
      route: "s3:/",
    });
  });

  test("a broken stdout is logged and the write it reports still settles", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const real = await memoryStore();
    store = real;
    logSpy.mockImplementation(() => {
      throw new Error("stdout gone");
    });
    try {
      recordStoragebaseAuditEvent(input());
      await elapse(1000);
      expect(error).toHaveBeenCalledTimes(1);
      expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });
});

describe("the sanitizer", () => {
  async function storedRow(event: StoragebaseAuditEventInput): Promise<StoragebaseAuditEvent> {
    const real = await memoryStore();
    store = real;
    recordStoragebaseAuditEvent(event);
    await elapse(1000);
    return (await real.queryAuditEvents({ limit: 1 })).events[0];
  }

  test("bounds every free-text field, and a statement to its own bound", async () => {
    const row = await storedRow({
      ...input(),
      details: "d".repeat(300),
      statement: "s".repeat(5000),
    });
    expect(row.details).toHaveLength(254);
    expect(row.statement).toHaveLength(4096);
  });

  test("redacts a URI-shaped credential anywhere a free-text field carries one", async () => {
    const row = await storedRow({
      ...input(),
      target: "see postgres://app:hunter2@db.internal:5432/app for the source",
    });
    expect(row.target).toContain("[REDACTED]");
    expect(row.target).not.toContain("hunter2");
    expect(row.target).toContain("db.internal:5432/app");
  });

  test("counts keep only finite numbers and booleans under identifier-shaped keys", async () => {
    const row = await storedRow({
      ...input(),
      counts: {
        ok: 1,
        flag: true,
        "bad-key!": 5,
        nope: Number.NaN,
        deeper: { nested: 1 },
      } as unknown as StoragebaseAuditEventInput["counts"],
    });
    expect(row.counts).toEqual({ ok: 1, flag: true });
  });

  test("counts keep at most MAX_AUDIT_COUNTS entries, the first ones", async () => {
    const counts: Record<string, number> = {};
    for (let i = 1; i <= MAX_AUDIT_COUNTS + 1; i += 1) counts[`c${i}`] = i;
    const row = await storedRow({ ...input(), counts });
    expect(row.counts).toEqual({ c1: 1, c2: 2, c3: 3, c4: 4, c5: 5, c6: 6, c7: 7, c8: 8 });
  });

  test("counts that survive nothing are omitted rather than recorded empty", async () => {
    const row = await storedRow({ ...input(), counts: { "bad-key!": 5 } });
    expect(row).not.toHaveProperty("counts");
  });

  test("a non-object counts value is omitted", async () => {
    const row = await storedRow({ ...input(), counts: 7 as unknown as StoragebaseAuditEventInput["counts"] });
    expect(row).not.toHaveProperty("counts");
  });

  test("a value a present non-string field does not declare is coerced to a bounded string", async () => {
    const withExtra = { ...input(), unknownLabel: { note: "object" } } as unknown as StoragebaseAuditEventInput;
    const row = await storedRow(withExtra);
    expect(asRecord(row).unknownLabel).toBe('{"note":"object"}');
  });

  test("an unserializable value degrades to a marker instead of throwing", async () => {
    const row = await storedRow({
      ...input(),
      unknownLabel: BigInt(7),
    } as unknown as StoragebaseAuditEventInput);
    expect(asRecord(row).unknownLabel).toBe("[unserializable]");
  });

  test("the number and boolean fields keep their own type", async () => {
    const row = await storedRow({ ...input(), duration: 12, rowsReturned: 3, statementTruncated: true });
    expect(row.duration).toBe(12);
    expect(row.rowsReturned).toBe(3);
    expect(row.statementTruncated).toBe(true);
  });

  test("a dangerous key is skipped, and the prototype is not touched", async () => {
    store = null;
    const poisoned = input();
    Object.defineProperty(poisoned, "__proto__", { value: "x", enumerable: true, writable: true, configurable: true });
    expect(() => recordStoragebaseAuditEvent(poisoned)).not.toThrow();
    await elapse(1000);
    expect(({} as { x?: string }).x).toBeUndefined();
    expect(parsedLines()).toHaveLength(1);
  });
});

describe("a store that fails", () => {
  test("a refused append keeps the batch queued, printed once, and backs off", async () => {
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    const refuse = { value: true };
    const real = await memoryStore();
    store = refusing(real, refuse);
    try {
      recordStoragebaseAuditEvent(input());
      await elapse(1000);
      // The line is out; the row is not.
      expect(parsedLines()).toHaveLength(1);
      expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(0);

      // The retry waits out the first backoff step, and fails again: no duplicate line.
      await elapse(1000);
      expect(parsedLines()).toHaveLength(1);
      expect(warned).toHaveBeenCalledTimes(2);

      // The retry after the doubled step settles the whole batch.
      refuse.value = false;
      await elapse(2000);
      expect(parsedLines()).toHaveLength(1);
      expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(1);
    } finally {
      warned.mockRestore();
    }
  });

  test("an append that settles part of the batch keeps only the rest queued", async () => {
    let refuseAt: number | null = 2;
    const real = await memoryStore();
    store = {
      appendAuditEvent: async (event: StoragebaseAuditEvent) => {
        if (refuseAt !== null && refuseAt === 0) {
          refuseAt = null;
          throw new Error("mid-batch failure");
        }
        if (refuseAt !== null) refuseAt -= 1;
        return real.appendAuditEvent(event);
      },
      queryAuditEvents: real.queryAuditEvents.bind(real),
      listRecords: real.listRecords.bind(real),
      putRecord: real.putRecord.bind(real),
      deleteRecord: real.deleteRecord.bind(real),
    };
    // Distinct timestamps, because same-millisecond events tie-break on their ids — minted
    // UUIDs — which is a stable but arbitrary order, not a chronological one.
    recordStoragebaseAuditEvent({ ...input({ action: "a.0" }), timestamp: "2026-09-24T10:00:00.000Z" });
    recordStoragebaseAuditEvent({ ...input({ action: "a.1" }), timestamp: "2026-09-24T10:01:00.000Z" });
    recordStoragebaseAuditEvent({ ...input({ action: "a.2" }), timestamp: "2026-09-24T10:02:00.000Z" });
    await flushStoragebaseAuditEvents();
    expect((await real.queryAuditEvents({ limit: 10 })).events.map((event) => event.action)).toEqual(["a.1", "a.0"]);
    // All three lines printed once, at the first attempt.
    expect(parsedLines()).toHaveLength(3);
    // The refused one is still queued, already printed: a second flush writes it, once more.
    await flushStoragebaseAuditEvents();
    expect(parsedLines()).toHaveLength(3);
    expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(3);
  });

  test("a store that cannot even be opened keeps the batch queued and prints the lines", async () => {
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    openError = new Error("storage unreachable");
    try {
      recordStoragebaseAuditEvent(input());
      await elapse(1000);
      expect(parsedLines()).toHaveLength(1);
      expect(storagebaseBufferedAuditEvents()).toHaveLength(1);
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });
});

describe("the shutdown flush", () => {
  test("drains every queued batch without waiting out the backoff", async () => {
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const real = await memoryStore();
      store = real;
      for (let i = 0; i < STORAGEBASE_AUDIT_BATCH_ROWS * 2 + 1; i += 1) {
        recordStoragebaseAuditEvent(input({ action: `drain.${i}` }));
      }
      await runShutdownHooks();
      expect((await real.queryAuditEvents({ limit: 10 })).events).toHaveLength(10);
      expect(parsedLines()).toHaveLength(STORAGEBASE_AUDIT_BATCH_ROWS * 2 + 1);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  test("a write that fails at shutdown leaves the rest unsent, logged, and nothing is armed after", async () => {
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    store = {
      appendAuditEvent: async () => {
        throw new Error("database down");
      },
    } as unknown as ForkStore;
    try {
      recordStoragebaseAuditEvent(input());
      await runShutdownHooks();
      expect(parsedLines()).toHaveLength(1);
      expect(warned).toHaveBeenCalledWith("StorageBase audit events not flushed at shutdown", {
        route: "storagebase-audit",
        unsent: 1,
      });
      // No flush is armed after the shutdown ran: nothing fires, however long the process lives.
      await elapse(30_000);
      expect(parsedLines()).toHaveLength(1);
    } finally {
      warned.mockRestore();
    }
  });

  test("a sink that recorded nothing flushes nothing", async () => {
    await runShutdownHooks();
    expect(parsedLines()).toEqual([]);
  });
});

describe("storagebaseAuditBackoffMs", () => {
  test("starts at a second, doubles per failure, and caps at 30", () => {
    expect(storagebaseAuditBackoffMs(1)).toBe(1000);
    expect(storagebaseAuditBackoffMs(2)).toBe(2000);
    expect(storagebaseAuditBackoffMs(3)).toBe(4000);
    expect(storagebaseAuditBackoffMs(10)).toBe(30_000);
  });
});
