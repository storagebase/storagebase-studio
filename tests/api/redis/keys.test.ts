import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { attachGrant } from "@/lib/access/grant";
import { getServerAuditBuffer } from "@/lib/audit";
import * as audit from "@/lib/audit";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

/**
 * The Redis key browser's routes (StorageBase fork): POST /api/redis/keys lists key names with a
 * bounded cursor SCAN, POST /api/redis/keys/meta describes a handful of them. The walk's own
 * bounds are unit tested in tests/unit/redis-keys/scan.test.ts.
 */

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "alice" }),
);
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}
const mockResolve = mock(async (body: Record<string, unknown>) => {
  if (body.connectionId === "seed:hidden") throw new SeedConnectionError('Seed connection "hidden" not found', 404);
  if (!body.connection) throw new SeedConnectionError("Either connection or connectionId is required", 400);
  return body.connection as DatabaseConnection;
});
mock.module("@/lib/seed/resolve-connection", () => ({ resolveConnection: mockResolve, SeedConnectionError }));

/** Commands sent, per provider the route opened. */
const opened: Array<{ connection: DatabaseConnection; sent: Array<{ command: string; args: string[] }> }> = [];
let answer: (command: string, args: string[]) => QueryResult = () => scanReply("0", []);
const disconnects = mock(async () => {});

mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: mock(async (connection: DatabaseConnection, run: (c: DatabaseConnection) => Promise<unknown>) =>
    run(connection),
  ),
  createDatabaseProvider: mock(async (connection: DatabaseConnection) => {
    const record = { connection, sent: [] as Array<{ command: string; args: string[] }> };
    opened.push(record);
    return {
      connect: mock(async () => {}),
      disconnect: disconnects,
      query: async (sql: string) => {
        const { command, args } = JSON.parse(sql) as { command: string; args: string[] };
        record.sent.push({ command, args });
        return answer(command, args);
      },
    };
  }),
}));

const { POST: listKeys } = await import("@/app/api/redis/keys/route");
const { POST: describeKeys } = await import("@/app/api/redis/keys/meta/route");

function scanReply(cursor: string, keys: string[]): QueryResult {
  return {
    rows: [
      { index: 1, value: cursor },
      { index: 2, value: JSON.stringify(keys) },
    ],
    fields: ["index", "value"],
    rowCount: 2,
    executionTime: 0,
  };
}

function status(text: string): QueryResult {
  return { rows: [{ result: text }], fields: ["result"], rowCount: 1, executionTime: 0 };
}

const redis: DatabaseConnection = {
  id: "cache-1",
  name: "Cache",
  type: "redis",
  host: "cache.internal",
  port: 6379,
  password: "s3cret-pw",
  database: "2",
  createdAt: new Date(0),
};

function request(path: string, body: unknown) {
  return createMockRequest(path, { method: "POST", body, headers: { "user-agent": "test" } }) as never;
}

function events() {
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "query_execution");
}

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  clearRateLimitState();
  getServerAuditBuffer().clear();
  opened.length = 0;
  disconnects.mockClear();
  answer = () => scanReply("0", []);
  mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe("POST /api/redis/keys", () => {
  test("401 without a session, before the body is read", async () => {
    mockGetSession.mockImplementation(async () => null);
    const res = await listKeys(request("/api/redis/keys", { connection: redis }));
    expect(res.status).toBe(401);
    expect(opened).toHaveLength(0);
  });

  test("scans the connection's own database by default and answers the page", async () => {
    answer = (_command, args) => (args[0] === "0" ? scanReply("12", ["a", "b"]) : scanReply("0", ["c"]));
    const res = await listKeys(request("/api/redis/keys", { connection: redis }));
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      keys: ["a", "b", "c"],
      cursor: "0",
      truncated: false,
      scanned: 3,
      iterations: 2,
      stoppedBy: "complete",
    });
    expect(opened[0].connection.database).toBe("2");
    expect(opened[0].sent.every((call) => call.command === "SCAN")).toBe(true);
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  test("opens the requested database and passes cursor, MATCH, TYPE and a clamped limit", async () => {
    answer = () => scanReply("0", ["user:1"]);
    await listKeys(
      request("/api/redis/keys", {
        connection: redis,
        database: 5,
        cursor: "88",
        match: "user:*",
        type: "hash",
        limit: 999_999,
      }),
    );
    expect(opened[0].connection.database).toBe("5");
    expect(opened[0].sent[0]).toEqual({
      command: "SCAN",
      args: ["88", "MATCH", "user:*", "COUNT", "500", "TYPE", "hash"],
    });
  });

  test("a truncated walk answers the cursor to resume from", async () => {
    answer = () =>
      scanReply(
        "31",
        Array.from({ length: 600 }, (_, i) => `k${i}`),
      );
    const res = await listKeys(request("/api/redis/keys", { connection: redis, limit: 500 }));
    const body = await parseResponseJSON<{ keys: string[]; cursor: string; truncated: boolean; stoppedBy: string }>(
      res,
    );
    expect(body).toMatchObject({ cursor: "31", truncated: true, stoppedBy: "limit" });
    expect(body.keys).toHaveLength(600);
  });

  test("400 for a body that is not a JSON object, or a bad field", async () => {
    const notJson = new Request("http://localhost:3000/api/redis/keys", { method: "POST", body: "{nope" });
    expect((await listKeys(notJson as never)).status).toBe(400);
    expect((await listKeys(request("/api/redis/keys", [1, 2]))).status).toBe(400);
    const bad = await listKeys(request("/api/redis/keys", { connection: redis, cursor: "x" }));
    expect(bad.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(bad)).error).toContain("cursor");
    expect(opened).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  test("400 for a connection that is not Redis", async () => {
    const res = await listKeys(request("/api/redis/keys", { connection: { ...redis, type: "postgres" } }));
    expect(res.status).toBe(400);
    expect(opened).toHaveLength(0);
  });

  test("a connection the caller cannot see answers 404, like one that does not exist", async () => {
    const res = await listKeys(request("/api/redis/keys", { connectionId: "seed:hidden" }));
    expect(res.status).toBe(404);
    expect(opened).toHaveLength(0);
  });

  test("a read grant on a managed connection is enough", async () => {
    const managed = attachGrant(
      { ...redis },
      { permission: "read", via: "binding", roles: ["ops"], groupIds: ["g"], groupNames: ["Ops"] },
    );
    mockResolve.mockImplementationOnce(async () => managed);
    const res = await listKeys(request("/api/redis/keys", { connectionId: "seed:cache" }));
    expect(res.status).toBe(200);
    expect(events()[0]).toMatchObject({ permission: "read", accessGroups: "Ops" });
  });

  test("records one query_execution event with counts only: no key, pattern or credential", async () => {
    answer = () => scanReply("0", ["secret-key-name"]);
    await listKeys(request("/api/redis/keys", { connection: redis, match: "secret-*" }));
    const recorded = events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: "redis.keys.list",
      result: "success",
      target: "POST /api/redis/keys",
      user: "alice",
      connectionId: "cache-1",
      engine: "redis",
      database: "2",
      counts: { keysReturned: 1, keysScanned: 1, iterations: 1, truncated: false },
    });
    const text = JSON.stringify(recorded[0]);
    expect(text).not.toContain("secret-");
    expect(text).not.toContain("s3cret-pw");
  });

  test("a failed walk is recorded as a failure, answered with the error, and still disconnects", async () => {
    answer = () => {
      throw new Error("NOPERM this user has no permissions to run the 'scan' command");
    };
    const res = await listKeys(request("/api/redis/keys", { connection: redis }));
    expect(res.status).toBe(500);
    expect(events()[0]).toMatchObject({ result: "failure", reason: "query_failed" });
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  test("a broken audit sink never changes the answer", async () => {
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => {
      throw new Error("sink down");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await listKeys(request("/api/redis/keys", { connection: redis }));
      expect(res.status).toBe(200);
    } finally {
      emit.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("the response never echoes the connection", async () => {
    const res = await listKeys(request("/api/redis/keys", { connection: redis }));
    expect(await res.text()).not.toContain("s3cret-pw");
  });
});

describe("POST /api/redis/keys/meta", () => {
  test("describes each distinct key with TYPE, TTL and MEMORY USAGE", async () => {
    answer = (command) => {
      if (command === "TYPE") return status("zset");
      if (command === "TTL") return status("(integer) 30");
      return status("(integer) 2048");
    };
    const res = await describeKeys(
      request("/api/redis/keys/meta", { connection: redis, database: 0, keys: ["a", "a"] }),
    );
    expect(res.status).toBe(200);
    expect(
      await parseResponseJSON<{ entries: Array<{ key: string; type: string; ttl: number; memory: number }> }>(res),
    ).toEqual({ entries: [{ key: "a", type: "zset", ttl: 30, memory: 2048 }] });
    expect(opened[0].connection.database).toBe("0");
    expect(events()[0]).toMatchObject({ action: "redis.keys.meta", counts: { keysDescribed: 1 } });
  });

  test("refuses more than 100 keys", async () => {
    const keys = Array.from({ length: 101 }, (_, i) => `k${i}`);
    const res = await describeKeys(request("/api/redis/keys/meta", { connection: redis, keys }));
    expect(res.status).toBe(400);
    expect(opened).toHaveLength(0);
  });
});
