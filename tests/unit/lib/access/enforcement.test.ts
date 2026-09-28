import { describe, test, expect, beforeEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { readOnlyVerdict } from "@/lib/access/read-only";
import { assertManagedStatement, requireManagedPermission } from "@/lib/access/db-guard";
import { requireResourcePermission } from "@/lib/access/resource-guard";
import { RESOURCE_ROUTE_PERMISSIONS, resourceRoutePermission } from "@/lib/access/resource-permissions";
import { attachGrant } from "@/lib/access/grant";
import { AccessDeniedError, AccessReadOnlyError } from "@/lib/access/errors";
import type { AccessPermission } from "@/lib/access/types";
import type { DatabaseConnection } from "@/lib/types";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * The enforcement layer (StorageBase fork): what a `read` grant may run, what each route needs, and
 * that a connection without a grant — user-owned, or a Helm seed — is never touched.
 */

const request = { headers: new Headers() };
const session = { role: "user", username: "alice" };

function database(permission?: AccessPermission, type: DatabaseConnection["type"] = "postgres"): DatabaseConnection {
  const connection: DatabaseConnection = { id: "seed:m_o", name: "Orders", type, createdAt: new Date() };
  return permission
    ? attachGrant(connection, { permission, via: "binding", roles: ["A"], groupIds: ["g"], groupNames: ["G"] })
    : connection;
}

function resource(permission?: AccessPermission): ResourceConnection {
  const connection: ResourceConnection = { id: "managed:v", name: "Vault", type: "azure-key-vault", createdAt: "t" };
  return permission
    ? attachGrant(connection, { permission, via: "binding", roles: ["A"], groupIds: ["g"], groupNames: ["G"] })
    : connection;
}

beforeEach(() => {
  getServerAuditBuffer().clear();
  clearRateLimitState();
});

describe("readOnlyVerdict: SQL", () => {
  const readOnly = [
    "SELECT * FROM orders",
    "select id from t where name = 'DROP TABLE x' -- INSERT",
    "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
    "SHOW TABLES",
    "DESCRIBE orders",
    "EXPLAIN SELECT 1",
    "SELECT 1; SELECT 2",
    'SELECT "update" FROM t',
  ];
  const writes: Array<[string, string]> = [
    ["DELETE FROM orders", "DELETE statements are not read-only"],
    ["UPDATE t SET a = 1", "UPDATE statements are not read-only"],
    ["CREATE TABLE t (a int)", "CREATE statements are not read-only"],
    ["SELECT 1; DROP TABLE t", "DROP statements are not read-only"],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "the statement contains DELETE"],
    ["SELECT * INTO copy FROM t", "the statement contains INTO"],
    ["SELECT * FROM t FOR UPDATE", "the statement contains UPDATE"],
    ["EXPLAIN ANALYZE DELETE FROM t", "the statement contains DELETE"],
    ["CALL refresh()", "CALL statements are not read-only"],
    ["SELECT 'unterminated", "the statement has an unterminated literal or comment"],
  ];

  test.each(readOnly)("reads: %s", (sql) => {
    expect(readOnlyVerdict(sql, "postgres")).toEqual({ readOnly: true });
  });

  test.each(writes)("refuses: %s", (sql, reason) => {
    expect(readOnlyVerdict(sql, "postgres")).toEqual({ readOnly: false, reason });
  });

  test("an empty text between terminators is no statement at all", () => {
    expect(readOnlyVerdict(";", "mysql")).toEqual({ readOnly: true });
  });
});

describe("readOnlyVerdict: MongoDB and Redis", () => {
  test("MongoDB reads, and the writing pipeline stages, and unreadable documents", () => {
    expect(readOnlyVerdict('{"collection":"c","operation":"find","filter":{}}', "mongodb")).toEqual({ readOnly: true });
    expect(readOnlyVerdict('{"collection":"c","operation":"aggregate","pipeline":[{"$match":{}}]}', "mongodb")).toEqual(
      {
        readOnly: true,
      },
    );
    expect(readOnlyVerdict('{"collection":"c","operation":"aggregate","pipeline":[{"$out":"x"}]}', "mongodb")).toEqual({
      readOnly: false,
      reason: "the pipeline writes with $out",
    });
    expect(readOnlyVerdict('{"collection":"c","operation":"deleteMany"}', "mongodb")).toEqual({
      readOnly: false,
      reason: "deleteMany is not a read operation",
    });
    expect(readOnlyVerdict("not json", "mongodb").readOnly).toBe(false);
    expect(readOnlyVerdict("", "mongodb").readOnly).toBe(false);
  });

  test("Redis read commands, readable sub-commands, and everything else refused", () => {
    expect(readOnlyVerdict("GET key", "redis")).toEqual({ readOnly: true });
    expect(readOnlyVerdict("hgetall h", "redis")).toEqual({ readOnly: true });
    expect(readOnlyVerdict("XINFO STREAM s", "redis")).toEqual({ readOnly: true });
    expect(readOnlyVerdict('{"command":"GET","args":["k"]}', "redis")).toEqual({ readOnly: true });
    expect(readOnlyVerdict("CONFIG GET requirepass", "redis")).toEqual({
      readOnly: false,
      reason: "CONFIG is not a read command",
    });
    expect(readOnlyVerdict("XINFO HELP", "redis").readOnly).toBe(false);
    expect(readOnlyVerdict("FLUSHALL", "redis").readOnly).toBe(false);
    expect(readOnlyVerdict("EVAL 'return 1' 0", "redis").readOnly).toBe(false);
    expect(readOnlyVerdict("{not json", "redis")).toEqual({ readOnly: false, reason: "no command could be read" });
  });
});

describe("database guards", () => {
  test("a connection with no grant is never touched, whatever it runs", () => {
    expect(() =>
      assertManagedStatement(request, session, database(), "DROP TABLE t", "POST /api/db/query"),
    ).not.toThrow();
    expect(() =>
      requireManagedPermission(request, session, database(), "admin", "POST /api/db/transaction"),
    ).not.toThrow();
    expect(getServerAuditBuffer().size).toBe(0);
  });

  test("write and admin grants run anything; a read grant runs reads and a missing statement is the route's 400", () => {
    for (const permission of ["write", "admin"] as const) {
      expect(() => assertManagedStatement(request, session, database(permission), "DELETE FROM t", "t")).not.toThrow();
    }
    expect(() => assertManagedStatement(request, session, database("read"), "SELECT 1", "t")).not.toThrow();
    expect(() => assertManagedStatement(request, session, database("read"), undefined, "t")).not.toThrow();
  });

  test("a read grant refuses a write with ACCESS_READ_ONLY and records it", () => {
    const refused = (() => {
      try {
        assertManagedStatement(request, session, database("read"), "DELETE FROM t", "POST /api/db/query");
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toBeInstanceOf(AccessReadOnlyError);
    expect(refused).toMatchObject({ statusCode: 403, code: "ACCESS_READ_ONLY" });
    expect((refused as Error).message).toBe('"Orders" is read-only for you: DELETE statements are not read-only.');
    expect(getServerAuditBuffer().getAll()[0]).toMatchObject({
      reason: "access_read_only",
      target: "POST /api/db/query",
    });
  });

  test("requireManagedPermission refuses below the requirement with ACCESS_DENIED", () => {
    expect(() => requireManagedPermission(request, session, database("write"), "write", "t")).not.toThrow();
    expect(() =>
      requireManagedPermission(request, session, database("read"), "write", "POST /api/db/transaction"),
    ).toThrow(AccessDeniedError);
    expect(getServerAuditBuffer().getAll()[0]).toMatchObject({ reason: "access_insufficient", permission: "read" });
  });
});

describe("resource guards", () => {
  test("every permission level against each class of route", () => {
    const cases: Array<[AccessPermission, string, boolean]> = [
      ["read", "api/resources/tree", true],
      ["read", "api/resources/secret/write", false],
      ["write", "api/resources/secret/write", true],
      ["write", "api/resources/message/purge", false],
      ["admin", "api/resources/message/purge", true],
      ["write", "api/resources/unmapped", false],
    ];
    for (const [permission, route, allowed] of cases) {
      const run = () => requireResourcePermission(request, session, resource(permission), route);
      if (allowed) expect(run).not.toThrow();
      else expect(run).toThrow(AccessDeniedError);
    }
    expect(() => requireResourcePermission(request, session, resource(), "api/resources/message/purge")).not.toThrow();
  });

  test("an unmapped route needs admin: a new route is closed until someone classifies it", () => {
    expect(resourceRoutePermission("api/resources/something-new")).toBe("admin");
    expect(resourceRoutePermission("api/resources/blob/download")).toBe("read");
  });

  test("the table and the resource route tree name exactly the same routes", () => {
    const root = join(import.meta.dir, "..", "..", "..", "..", "src", "app", "api", "resources");
    const declared: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") {
          const match = readFileSync(full, "utf8").match(/handleResourceRequest\(\s*\w+,\s*"([^"]+)"/);
          if (match) declared.push(match[1]);
        }
      }
    };
    walk(root);
    expect(declared.length).toBeGreaterThan(30);
    expect(declared.sort()).toEqual(Object.keys(RESOURCE_ROUTE_PERMISSIONS).sort());
  });
});
