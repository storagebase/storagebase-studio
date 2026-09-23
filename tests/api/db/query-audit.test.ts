import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { getServerAuditBuffer } from "@/lib/audit";
import * as audit from "@/lib/audit";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";

/**
 * The `query_execution` hook in POST /api/db/query (StorageBase fork): one event per statement the
 * route tried to run, on success and on failure, none for a request refused before it ran, and a
 * broken audit sink never changes the route's answer. What the event holds is unit tested in
 * tests/unit/lib/api/query-audit.test.ts; that no literal escapes is
 * tests/security/query-audit-redaction.test.ts.
 */

const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

// The guard, not `@/lib/auth`: these tests are about what happens after a caller is admitted, and
// the route's own guard tests (tests/api/db/query.test.ts) cover the admission.
mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => ({ session: { role: "user", username: "alice" } })),
  auditRoleDenial: mock(() => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: mock(async (body: Record<string, unknown>) => {
    if (!body.connection) throw new Error("Either connection or connectionId is required");
    return body.connection;
  }),
  SeedConnectionError: class extends Error {},
}));

mock.module("@/lib/db", () => ({ getOrCreateProvider: mockGetOrCreateProvider }));

const { POST } = await import("@/app/api/db/query/route");

const connection = {
  id: "conn-1",
  name: "Orders DB",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "orders",
};

function queryRequest(body: Record<string, unknown>) {
  return createMockRequest("/api/db/query", {
    method: "POST",
    body,
    headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0" },
  });
}

function queryEvents() {
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "query_execution");
}

describe("POST /api/db/query records a query_execution event", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getServerAuditBuffer().clear();
    mockGetOrCreateProvider.mockReset();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("a successful statement is recorded once, as the caller, with the masked text", async () => {
    const res = await POST(queryRequest({ connection, sql: "SELECT * FROM orders WHERE id = 42" }) as never);

    expect(res.status).toBe(200);
    const events = queryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "executed",
      result: "success",
      user: "alice",
      role: "user",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      connectionName: "Orders DB",
      engine: "postgres",
      statementKind: "SELECT",
      statement: "SELECT * FROM orders WHERE id = ?",
    });
  });

  test("an EXPLAIN request is recorded as explained", async () => {
    mockGetOrCreateProvider.mockImplementation(async () =>
      createMockProvider({ capabilities: { explainFormat: "postgres-json" } }),
    );
    const res = await POST(
      queryRequest({ connection, sql: "SELECT * FROM orders", explain: { mode: "estimate" } }) as never,
    );

    expect(res.status).toBe(200);
    expect(queryEvents()[0]?.action).toBe("explained");
  });

  test("a statement the engine refuses is recorded as a failure, and the route still answers with it", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new QueryError('column "nope" does not exist', "postgres");
    });
    const res = await POST(queryRequest({ connection, sql: "SELECT nope FROM orders" }) as never);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const [event] = queryEvents();
    expect(event).toMatchObject({ action: "failed", result: "failure", reason: "query_failed" });
  });

  test("a cancelled statement is recorded as cancelled", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new QueryCancelledError("Query was cancelled", "postgres");
    });
    await POST(queryRequest({ connection, sql: "SELECT pg_sleep(60)", queryId: "q-9" }) as never);

    expect(queryEvents()[0]).toMatchObject({ action: "cancelled", reason: "query_cancelled", queryId: "q-9" });
  });

  test("a connection that cannot be opened is recorded as a failure of the statement", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await POST(queryRequest({ connection, sql: "SELECT 1" }) as never);

    expect(queryEvents()[0]).toMatchObject({ result: "failure", reason: "query_failed" });
  });

  test("a request refused before anything ran records nothing", async () => {
    const missingSql = await POST(queryRequest({ connection }) as never);
    const badParams = await POST(queryRequest({ connection, sql: "SELECT 1", params: "nope" }) as never);
    const missingConnection = await POST(queryRequest({ sql: "SELECT 1" }) as never);

    expect(missingSql.status).toBe(400);
    expect(badParams.status).toBe(400);
    expect(missingConnection.status).toBeGreaterThanOrEqual(400);
    expect(queryEvents()).toHaveLength(0);
  });

  test("a broken audit sink changes nothing about the answer", async () => {
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => {
      throw new Error("ring buffer full");
    });
    try {
      const res = await POST(queryRequest({ connection, sql: "SELECT 1" }) as never);
      const data = await parseResponseJSON<{ rows: unknown[] }>(res);
      expect(res.status).toBe(200);
      expect(Array.isArray(data.rows)).toBe(true);
      // The sink really was the broken one: without this the test passes against a working sink.
      expect(emit).toHaveBeenCalledTimes(1);
    } finally {
      emit.mockRestore();
    }
  });
});
