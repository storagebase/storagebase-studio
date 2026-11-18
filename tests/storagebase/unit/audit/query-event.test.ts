import { describe, test, expect } from "bun:test";
import type { QueryEventInput } from "@/lib/query-events/types";
import { storagebaseQueryEvent } from "@/storagebase/audit/query-event";

/**
 * The `query_execution` fork event the S2 tap builds from one `QueryEventInput`, against the exact
 * field set of src/lib/query-events/types.ts at the S2 ref (verified: principal subject/username/
 * role, connection id/name/engine/accessLevel, statement, status, statementType, started, explain,
 * rowCount, unitIndex, errorCode, errorMessage, correlationId, transactionId, transactionOutcome,
 * clientIp). The masking itself is unit-tested in masker.test.ts; what is pinned here is which
 * input field lands in which event field, and which never does.
 */

function input(overrides: Partial<QueryEventInput> = {}): QueryEventInput {
  return {
    source: "editor",
    principal: { subject: "sub-1", username: "alice", role: "user" },
    connection: { id: "seed:orders", name: "Orders DB", engine: "postgres", accessLevel: "write" },
    statement: "SELECT * FROM orders WHERE email = 'a@b.com'",
    status: "success",
    started: { wallClockMs: Date.now() - 7, monotonicMs: performance.now() - 7 },
    ...overrides,
  };
}

describe("storagebaseQueryEvent", () => {
  test("a success records who, against what, the masked statement and the rows", () => {
    const event = storagebaseQueryEvent(input({ rowCount: 2, correlationId: "corr-1", clientIp: "203.0.113.9" }));
    expect(event).toMatchObject({
      type: "query_execution",
      action: "executed",
      target: "editor",
      user: "alice",
      role: "user",
      subject: "sub-1",
      connectionId: "seed:orders",
      connectionName: "Orders DB",
      engine: "postgres",
      statementKind: "SELECT",
      statement: "SELECT * FROM orders WHERE email = ?",
      rowsReturned: 2,
      correlationId: "corr-1",
      ip: "203.0.113.9",
    });
    expect(event.duration).toBeGreaterThanOrEqual(7);
    expect(event).not.toHaveProperty("rowsAffected");
    expect(event).not.toHaveProperty("statementTruncated");
    expect(event).not.toHaveProperty("error");
    expect(event).not.toHaveProperty("reason");
    expect(event).not.toHaveProperty("host");
    expect(event).not.toHaveProperty("database");
    expect(event).not.toHaveProperty("queryId");
  });

  test("a write records the rows it affected, and an EXPLAIN never does", () => {
    expect(storagebaseQueryEvent(input({ statement: "UPDATE orders SET paid = true", rowCount: 3 }))).toMatchObject({
      statementKind: "UPDATE",
      rowsAffected: 3,
    });
    expect(
      storagebaseQueryEvent(input({ statement: "DELETE FROM orders", rowCount: 1, explain: "estimate" })),
    ).toMatchObject({ action: "explained", rowsReturned: 1 });
    expect(
      storagebaseQueryEvent(input({ statement: "DELETE FROM orders", rowCount: 1, explain: "estimate" })),
    ).not.toHaveProperty("rowsAffected");
  });

  test("the user falls back to the role when the session carries no name", () => {
    expect(storagebaseQueryEvent(input({ principal: { subject: "s", username: "", role: "admin" } }))).toMatchObject({
      user: "admin",
      role: "admin",
    });
  });

  test("a truncated statement says so", () => {
    const event = storagebaseQueryEvent(input({ statement: `SELECT ${"a, ".repeat(3000)}b FROM t` }));
    expect(event.statementTruncated).toBe(true);
  });

  test("a connection that never resolved records the requested id and no engine", () => {
    const event = storagebaseQueryEvent(
      input({
        connection: { id: "seed:nope", name: null, engine: null, accessLevel: null },
        status: "refused",
        errorCode: "CONNECTION_NOT_FOUND",
        statement: null,
      }),
    );
    expect(event).toMatchObject({
      action: "refused",
      target: "editor",
      connectionId: "seed:nope",
      reason: "CONNECTION_NOT_FOUND",
    });
    expect(event).not.toHaveProperty("engine");
    expect(event).not.toHaveProperty("statement");
    expect(event).not.toHaveProperty("statementKind");
  });

  test.each([
    ["error", "failed"],
    ["cancelled", "cancelled"],
    ["refused", "refused"],
  ] as const)("a status %s records the action %s and a failure", (status, action) => {
    expect(storagebaseQueryEvent(input({ status }))).toMatchObject({ action, result: "failure" });
  });

  test("a failure records the masked error text and the code as the reason", () => {
    const event = storagebaseQueryEvent(
      input({
        status: "error",
        errorCode: "42703",
        errorMessage: 'column "secret_table" does not exist',
      }),
    );
    expect(event).toMatchObject({ action: "failed", result: "failure", reason: "42703" });
    expect(event.error).toBe("column ? does not exist");
    expect(event.error).not.toContain("secret_table");
  });

  test("a statement the route already classified keeps the route's kind, whatever its text says", () => {
    const event = storagebaseQueryEvent(input({ statement: "public.orders", statementType: "SELECT", rowCount: 4 }));
    expect(event).toMatchObject({ statementKind: "SELECT", statement: "public.orders", rowsReturned: 4 });
  });

  test("a non-SQL engine masks its document and classifies it by its operation", () => {
    const document = JSON.stringify({
      collection: "users",
      operation: "find",
      filter: { token: "s3cr3t" },
    });
    const event = storagebaseQueryEvent(
      input({ connection: { id: "c", name: "Mongo", engine: "mongodb", accessLevel: "read" }, statement: document }),
    );
    expect(event.statement).not.toContain("s3cr3t");
    expect(event.statementKind).toBe("SELECT");
  });

  test("a unit with no text records no statement and no kind", () => {
    const event = storagebaseQueryEvent(input({ statement: "" }));
    expect(event).not.toHaveProperty("statement");
    expect(event).not.toHaveProperty("statementKind");
  });
});
