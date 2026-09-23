import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));
const mockLoggerError = mock((..._args: unknown[]) => {});

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
  MAX_AUDIT_STATEMENT_LENGTH: 4096,
}));
mock.module("@/lib/logger", () => ({
  logger: { error: mockLoggerError, warn: mock(), info: mock(), debug: mock() },
}));

const { startQueryAudit } = await import("@/lib/api/query-audit");

const connection = {
  id: "conn-1",
  name: "Orders DB",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "orders",
  user: "app",
  password: "hunter2",
  createdAt: new Date(),
} as DatabaseConnection;

const session = { role: "user", username: "alice" };

function request(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) };
}

function lastEvent(): Record<string, unknown> {
  return mockEmitAuditEvent.mock.calls.at(-1)?.[0] ?? {};
}

describe("startQueryAudit", () => {
  const savedTrust = process.env.TRUST_PROXY_HEADERS;

  beforeEach(() => {
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
    mockLoggerError.mockClear();
    delete process.env.TRUST_PROXY_HEADERS;
  });

  afterEach(() => {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = savedTrust;
  });

  test("a success records who, where from, against what, the masked statement and the rows", () => {
    const audit = startQueryAudit(
      request({ "x-forwarded-for": "203.0.113.9, 10.0.0.2", "user-agent": "Mozilla/5.0" }),
      session,
    );
    audit.attempt(connection, "SELECT * FROM orders WHERE email = 'a@b.com'", { queryId: "q-1" });
    audit.succeeded({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });

    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event).toMatchObject({
      type: "query_execution",
      action: "executed",
      target: "POST /api/db/query",
      result: "success",
      user: "alice",
      role: "user",
      ip: "203.0.113.9",
      forwardedFor: "203.0.113.9, 10.0.0.2",
      userAgent: "Mozilla/5.0",
      connectionId: "conn-1",
      connectionName: "Orders DB",
      engine: "postgres",
      host: "db.internal:5432",
      database: "orders",
      statementKind: "SELECT",
      statement: "SELECT * FROM orders WHERE email = ?",
      rowsReturned: 2,
      queryId: "q-1",
    });
    expect(typeof event.duration).toBe("number");
    expect(event).not.toHaveProperty("rowsAffected");
    expect(event).not.toHaveProperty("statementTruncated");
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  test("a write records the rows it affected", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "UPDATE orders SET paid = true WHERE id = 7");
    audit.succeeded({ rows: [], rowCount: 3 });

    expect(lastEvent()).toMatchObject({ statementKind: "UPDATE", rowsReturned: 0, rowsAffected: 3 });
  });

  test("an EXPLAIN is recorded as explained, without an affected-row count", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "DELETE FROM orders WHERE id = 7", { explain: "estimate" });
    audit.succeeded({ rows: [{ plan: 1 }], rowCount: 1 });

    const event = lastEvent();
    expect(event.action).toBe("explained");
    expect(event).not.toHaveProperty("rowsAffected");
  });

  test("the user falls back to the role when the session carries no name", () => {
    const audit = startQueryAudit(request(), { role: "admin" });
    audit.attempt(connection, "SELECT 1");
    audit.succeeded({ rows: [], rowCount: 0 });

    expect(lastEvent()).toMatchObject({ user: "admin", role: "admin" });
  });

  test("a non-string query id is not recorded", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "SELECT 1", { queryId: { nested: true } });
    audit.succeeded({ rows: [], rowCount: 0 });

    expect(lastEvent()).not.toHaveProperty("queryId");
  });

  test("a truncated statement says so", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, `SELECT ${"a, ".repeat(3000)}b FROM t`);
    audit.succeeded({ rows: [], rowCount: 0 });

    expect(lastEvent().statementTruncated).toBe(true);
  });

  test("a connection with no host field records no host, and a host with no port records it bare", () => {
    const bare = startQueryAudit(request(), session);
    bare.attempt({ ...connection, host: undefined, connectionString: "postgres://u:p@h/db" }, "SELECT 1");
    bare.succeeded({ rows: [], rowCount: 0 });
    expect(lastEvent().host).toBeUndefined();
    expect(JSON.stringify(lastEvent())).not.toContain("postgres://");

    const noPort = startQueryAudit(request(), session);
    noPort.attempt({ ...connection, port: undefined }, "SELECT 1");
    noPort.succeeded({ rows: [], rowCount: 0 });
    expect(lastEvent().host).toBe("db.internal");
  });

  test.each([
    [new QueryError('relation "secret_table" does not exist', "postgres"), "failed", "query_failed"],
    [new QueryCancelledError("Query cancelled", "postgres"), "cancelled", "query_cancelled"],
    [new TimeoutError("Query timed out after 60000ms", "postgres"), "timed_out", "query_timeout"],
  ])("a failure %p is recorded as %p with reason %p", (error, action, reason) => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "SELECT pg_sleep(100)");
    audit.failed(error);

    const event = lastEvent();
    expect(event).toMatchObject({ result: "failure", action, reason, statementKind: "SELECT" });
    expect(String(event.error)).toStartWith(`${error.name}: `);
    expect(String(event.error)).not.toContain("secret_table");
    expect(String(event.error)).not.toContain("60000");
  });

  test("a thrown non-Error is recorded with its text masked", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "SELECT 1");
    audit.failed("bad value 's3cr3t'");

    expect(lastEvent().error).toBe("bad value ?");
  });

  test("a failure before the attempt records nothing", () => {
    const audit = startQueryAudit(request(), session);
    audit.failed(new Error("Empty body"));
    audit.succeeded({ rows: [], rowCount: 0 });

    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });

  test("one attempt records one event, even when the route reports twice", () => {
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "SELECT 1");
    audit.succeeded({ rows: [], rowCount: 0 });
    audit.failed(new Error("serialization failed"));

    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
  });

  test("a broken sink is logged and never thrown", () => {
    mockEmitAuditEvent.mockImplementation(() => {
      throw new Error("ring buffer full");
    });
    const audit = startQueryAudit(request(), session);
    audit.attempt(connection, "SELECT 1");

    expect(() => audit.succeeded({ rows: [], rowCount: 0 })).not.toThrow();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  test("a request that cannot be read is logged, never thrown, and records nothing", () => {
    const unreadable = {
      headers: {
        get: () => {
          throw new Error("headers gone");
        },
      } as unknown as Headers,
    };
    const audit = startQueryAudit(unreadable, session);

    expect(() => audit.attempt(connection, "SELECT 1")).not.toThrow();
    audit.succeeded({ rows: [], rowCount: 0 });
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  test("with proxy trust off, neither the forwarded chain nor an address derived from it is recorded", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    const audit = startQueryAudit(request({ "x-forwarded-for": "203.0.113.9" }), session);
    audit.attempt(connection, "SELECT 1");
    audit.succeeded({ rows: [], rowCount: 0 });

    const event = lastEvent();
    expect(event).not.toHaveProperty("ip");
    expect(event).not.toHaveProperty("forwardedFor");
  });
});
