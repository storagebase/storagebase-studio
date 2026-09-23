import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { createMockRequest } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { getServerAuditBuffer } from "@/lib/audit";
import { QueryError } from "@/lib/db/errors";

/**
 * Threat: a value a user queried with reaching the audit trail. `query_execution` events carry the
 * statement (StorageBase fork), and a log pipeline is a far wider audience than the database the
 * value was sent to - so a password in a WHERE clause, a token in a Redis SET, a card number in a
 * Mongo filter or a driver error that echoes one back must never appear in ANY of the three places
 * an event lives: the event the emitter returns (here, the buffer's copy of it), the ring buffer
 * the admin API serves, and the authoritative `libredb.audit.v1` stdout line. Neither may the
 * connection's credentials.
 *
 * Driven through the real route and the real emitter, so the proof covers the whole path rather
 * than the masker alone (tests/unit/lib/audit-sql.test.ts covers the masker's cases one by one).
 */

const SECRET = "s3cr3t";
const PASSWORD = "hunter2-db-password";

let provider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => provider);

// The guard, not `@/lib/auth`: these tests are about what happens after a caller is admitted, and
// the route's own guard tests (tests/api/db/query.test.ts) cover the admission.
mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => ({ session: { role: "user", username: "alice" } })),
  auditRoleDenial: mock(() => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: mock(async (body: Record<string, unknown>) => body.connection),
  SeedConnectionError: class extends Error {},
}));

mock.module("@/lib/db", () => ({ getOrCreateProvider: mockGetOrCreateProvider }));

const { POST } = await import("@/app/api/db/query/route");

function connectionFor(type: string) {
  return {
    id: "conn-1",
    name: "Prod",
    type,
    host: "db.internal",
    port: 5432,
    user: "app",
    password: PASSWORD,
    database: "app",
    connectionString: `postgres://app:${PASSWORD}@db.internal:5432/app`,
  };
}

/** Everything the emitter wrote to stdout during `run`, one parsed line per call. */
async function captureLines(run: () => Promise<unknown>): Promise<string[]> {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

async function runQuery(type: string, sql: string): Promise<string[]> {
  return captureLines(() =>
    POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: connectionFor(type), sql },
      }) as never,
    ),
  );
}

function expectNothingLeaked(lines: string[]) {
  const queryLines = lines.filter((line) => line.includes('"event":"query_execution"'));
  expect(queryLines).toHaveLength(1);
  // One physical line, parseable, and carrying the statement it is about.
  expect(queryLines[0].split("\n")).toHaveLength(1);
  const parsed = JSON.parse(queryLines[0]) as Record<string, unknown>;
  expect(typeof parsed.statement).toBe("string");

  const buffered = JSON.stringify(getServerAuditBuffer().getAll());
  for (const destination of [queryLines[0], buffered]) {
    expect(destination).not.toContain(SECRET);
    expect(destination).not.toContain(PASSWORD);
    expect(destination).not.toContain("postgres://");
  }
}

describe("a query_execution event never carries a literal or a credential", () => {
  beforeEach(() => {
    getServerAuditBuffer().clear();
    provider = createMockProvider();
  });

  afterEach(() => {
    getServerAuditBuffer().clear();
  });

  test("a SQL string literal", async () => {
    expectNothingLeaked(await runQuery("postgres", `SELECT * FROM users WHERE password = '${SECRET}'`));
  });

  test("a literal hidden in a comment, a dollar quote and an escaped quote", async () => {
    expectNothingLeaked(
      await runQuery("postgres", `SELECT 1 /* ${SECRET} */, $$${SECRET}$$, 'it''s ${SECRET}' -- ${SECRET}\nFROM t`),
    );
  });

  test("a driver error that echoes the literal back", async () => {
    (provider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new QueryError(`invalid input syntax for type integer: "${SECRET}"`, "postgres");
    });
    expectNothingLeaked(await runQuery("postgres", `SELECT * FROM t WHERE id = '${SECRET}'`));
  });

  test("a MongoDB filter value", async () => {
    expectNothingLeaked(
      await runQuery("mongodb", JSON.stringify({ collection: "users", operation: "find", filter: { pw: SECRET } })),
    );
  });

  test("a Redis command argument, key included", async () => {
    expectNothingLeaked(await runQuery("redis", `SET token:${SECRET} "${SECRET}"`));
  });
});
