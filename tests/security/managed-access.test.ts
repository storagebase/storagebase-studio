import { describe, test, expect, beforeEach, beforeAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import { installAccessStore } from "../helpers/access-store";
import { createMockProvider } from "../helpers/mock-provider";
import {
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";
import { installAuthMock } from "../helpers/auth-mock";

/**
 * Threat model for managed (preconfigured) connections (StorageBase fork), end to end through the
 * real routes, the real seed/resource resolution and a real SQLite fork store:
 *
 * 1. A reader cannot write — a database statement that is not read-only, a write route, or a
 *    resource route above its grant is refused before anything reaches the engine.
 * 2. A non-member gets 404 and learns nothing: the same answer as for an id that does not exist.
 * 3. A managed credential never appears in any API response or audit line, for any caller.
 * 4. Admin bypass works (and is audited as such).
 * 5. User-owned connections are untouched by all of it.
 *
 * Only the ENGINES are doubled: the database provider at the `@/lib/db` barrel, the blob provider
 * through the resource registry. Role values are placeholders.
 */

const handle = installAccessStore();

let session: Record<string, unknown> | null = null;
installAuthMock({ getSession: () => session });

const provider = createMockProvider();
const openedWith: Array<Record<string, unknown>> = [];
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(async (connection: Record<string, unknown>) => {
    openedWith.push(connection);
    return provider;
  }),
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

const store = await import("@/lib/access/store");
const { POST: query } = await import("@/app/api/db/query/route");
const { POST: multiQuery } = await import("@/app/api/db/multi-query/route");
const { POST: transaction } = await import("@/app/api/db/transaction/route");
const { GET: managedDatabases } = await import("@/app/api/connections/managed/route");
const { GET: managedResources } = await import("@/app/api/resources/managed/route");
const { POST: tree } = await import("@/app/api/resources/tree/route");
const { POST: blobDelete } = await import("@/app/api/resources/blob/delete/route");
const { BaseResourceProvider } = await import("@/lib/resources/base-provider");
const { registerResourceProviderLoader } = await import("@/lib/resources/registry");
const { clearResourceProviderCache } = await import("@/lib/resources/factory");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { resetManagedUseTracking } = await import("@/lib/access/audit");

const DB_SECRET = "orders-db-password-value";
const BLOB_SECRET = "bucket-secret-access-key";

const deleted: string[] = [];
class FakeBlobProvider extends BaseResourceProvider {
  async connect() {
    this.setConnected(true);
  }
  async disconnect() {
    this.setConnected(false);
  }
  async getHealth() {
    return { status: "healthy" as const };
  }
  getCapabilities() {
    return {
      category: "blob" as const,
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "blob.delete"] as const,
    };
  }
  getLabels() {
    return { containerNoun: "Buckets", itemNoun: "Objects" };
  }
  async listNodes() {
    return {
      nodes: [{ id: "b", parentId: null, kind: "bucket", name: "reports", hasChildren: true }],
      truncated: false,
    };
  }
  async listBuckets() {
    return this.listNodes();
  }
  async deleteBlob(bucket: string, name: string) {
    deleted.push(`${bucket}/${name}`);
  }
}

const reader = { role: "user", username: "alice", provider: "entra", appRoles: ["Team.Payments.Read"] };
const writer = { role: "user", username: "bob", provider: "entra", appRoles: ["Team.Payments.Write"] };
const stranger = { role: "user", username: "eve", provider: "entra", appRoles: ["Team.Other.Read"] };
const admin = { role: "admin", username: "root", provider: "entra", appRoles: ["StorageBase.Admin"] };

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://studio.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function answer(response: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

const MANAGED_DB = { connectionId: "seed:m_orders" };
const MANAGED_BUCKET = { connectionId: "managed:reports" };

beforeAll(() => {
  registerResourceProviderLoader("s3", async () => ({ default: FakeBlobProvider as never }));
});

beforeEach(async () => {
  await handle.reset();
  clearResourceProviderCache();
  clearRateLimitState();
  resetManagedUseTracking();
  getServerAuditBuffer().clear();
  openedWith.length = 0;
  deleted.length = 0;
  session = null;
  await store.createGroup({ id: "payments", name: "Payments" }, "root");
  await store.createBinding({ appRoleValue: "Team.Payments.Read", groupId: "payments", permission: "read" }, "root");
  await store.createBinding({ appRoleValue: "Team.Payments.Write", groupId: "payments", permission: "write" }, "root");
  await store.createManagedConnection(
    {
      id: "orders",
      kind: "database",
      type: "postgres",
      name: "Orders",
      groupIds: ["payments"],
      config: { host: "db.internal", port: 5432, user: "app", password: DB_SECRET, database: "orders" },
    },
    "root",
  );
  await store.createManagedConnection(
    {
      id: "reports",
      kind: "resource",
      type: "s3",
      name: "Reports",
      groupIds: ["payments"],
      config: { region: "eu-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: BLOB_SECRET },
    },
    "root",
  );
});

describe("1. a reader cannot write", () => {
  test("a SELECT runs on the managed connection, opened server-side with its credential", async () => {
    session = reader;
    const result = await answer(await query(post("/api/db/query", { ...MANAGED_DB, sql: "SELECT * FROM orders" })));
    expect(result.status).toBe(200);
    expect(openedWith[0]).toMatchObject({ id: "seed:m_orders", host: "db.internal", password: DB_SECRET });
  });

  test.each([
    ["DELETE FROM orders"],
    ["UPDATE orders SET paid = true"],
    ["SELECT 1; DROP TABLE orders"],
    ["WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone"],
  ])("the query route refuses %s with 403 ACCESS_READ_ONLY before the engine", async (sql) => {
    session = reader;
    const result = await answer(await query(post("/api/db/query", { ...MANAGED_DB, sql })));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("ACCESS_READ_ONLY");
    expect(openedWith).toHaveLength(0);
  });

  test("the multi-query route refuses a script with any write in it", async () => {
    session = reader;
    const result = await answer(
      await multiQuery(post("/api/db/multi-query", { ...MANAGED_DB, sql: "SELECT 1; DELETE FROM t" })),
    );
    expect(result.status).toBe(403);
    expect(openedWith).toHaveLength(0);
  });

  test("a reader cannot open a transaction; the status probe is allowed", async () => {
    session = reader;
    expect(
      (await answer(await transaction(post("/api/db/transaction", { ...MANAGED_DB, action: "begin" })))).body.code,
    ).toBe("ACCESS_DENIED");
    expect(openedWith).toHaveLength(0);
    await transaction(post("/api/db/transaction", { ...MANAGED_DB, action: "status" }));
    expect(openedWith).toHaveLength(1);
  });

  test("a writer's DELETE reaches the engine, with the grant on its audit line", async () => {
    session = writer;
    const result = await answer(
      await query(post("/api/db/query", { ...MANAGED_DB, sql: "DELETE FROM orders WHERE id = 1" })),
    );
    expect(result.status).toBe(200);
    const executed = getServerAuditBuffer()
      .getAll()
      .find((event) => event.type === "query_execution");
    expect(executed).toMatchObject({ permission: "write", grantedBy: "Team.Payments.Write", accessGroups: "Payments" });
  });

  test("a resource reader lists but cannot delete; a writer can", async () => {
    session = reader;
    expect((await answer(await tree(post("/api/resources/tree", MANAGED_BUCKET)))).status).toBe(200);
    const refused = await answer(
      await blobDelete(post("/api/resources/blob/delete", { ...MANAGED_BUCKET, bucket: "reports", name: "q3.csv" })),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ACCESS_DENIED");
    expect(deleted).toEqual([]);

    session = writer;
    const allowed = await answer(
      await blobDelete(post("/api/resources/blob/delete", { ...MANAGED_BUCKET, bucket: "reports", name: "q3.csv" })),
    );
    expect(allowed.status).toBe(200);
    expect(deleted).toEqual(["reports/q3.csv"]);
  });
});

describe("2. a non-member gets 404 and learns nothing", () => {
  test("the database answer is the one a missing id gets", async () => {
    session = stranger;
    const hidden = await answer(await query(post("/api/db/query", { ...MANAGED_DB, sql: "SELECT 1" })));
    const missing = await answer(
      await query(post("/api/db/query", { connectionId: "seed:m_nothing", sql: "SELECT 1" })),
    );
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.text.replace("m_orders", "X")).toBe(missing.text.replace("m_nothing", "X"));
    expect(openedWith).toHaveLength(0);
  });

  test("the resource answer is the one a missing id gets, and neither list shows it", async () => {
    session = stranger;
    const hidden = await answer(await tree(post("/api/resources/tree", MANAGED_BUCKET)));
    const missing = await answer(await tree(post("/api/resources/tree", { connectionId: "managed:nothing" })));
    expect(hidden).toEqual(missing);
    expect(hidden.status).toBe(404);
    expect((await answer(await managedResources())).body).toEqual({ connections: [] });
    const seeds = (await answer(await managedDatabases())).body.connections as Array<{ seedId?: string }>;
    expect(seeds.some((row) => row.seedId === "m_orders")).toBe(false);
  });

  test("the probe of a real one is on the trail", async () => {
    session = stranger;
    await tree(post("/api/resources/tree", MANAGED_BUCKET));
    expect(
      getServerAuditBuffer()
        .getAll()
        .find((event) => event.type === "permission_denied"),
    ).toMatchObject({
      reason: "access_not_granted",
      user: "eve",
      target: "managed:reports",
    });
  });
});

describe("3. managed credentials never leave the server", () => {
  test("no response, for any caller, and no audit line carries one", async () => {
    const texts: string[] = [];
    for (const caller of [reader, writer, stranger, admin]) {
      session = caller;
      texts.push((await answer(await managedDatabases())).text);
      texts.push((await answer(await managedResources())).text);
      texts.push((await answer(await query(post("/api/db/query", { ...MANAGED_DB, sql: "DELETE FROM x" })))).text);
      texts.push((await answer(await tree(post("/api/resources/tree", MANAGED_BUCKET)))).text);
      texts.push(
        (
          await answer(
            await blobDelete(post("/api/resources/blob/delete", { ...MANAGED_BUCKET, bucket: "b", name: "n" })),
          )
        ).text,
      );
    }
    texts.push(JSON.stringify(getServerAuditBuffer().getAll()));
    for (const text of texts) {
      for (const secret of [DB_SECRET, BLOB_SECRET]) expect(text).not.toContain(secret);
    }
  });

  test("the listed rows carry no host, user, address or key id either", async () => {
    session = admin;
    const listed = (await answer(await managedDatabases())).text + (await answer(await managedResources())).text;
    for (const detail of ["db.internal", '"user":"app"', "eu-west-1", "AKIAEXAMPLE"])
      expect(listed).not.toContain(detail);
  });
});

describe("4. admin bypass", () => {
  test("an administrator writes to every managed connection, audited as admin-bypass", async () => {
    session = admin;
    expect(
      (await answer(await query(post("/api/db/query", { ...MANAGED_DB, sql: "DELETE FROM orders" })))).status,
    ).toBe(200);
    expect(
      (
        await answer(
          await blobDelete(post("/api/resources/blob/delete", { ...MANAGED_BUCKET, bucket: "b", name: "n" })),
        )
      ).status,
    ).toBe(200);
    const grants = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.grantedBy !== undefined)
      .map((event) => event.grantedBy);
    expect(new Set(grants)).toEqual(new Set(["admin-bypass"]));
  });
});

describe("5. user-owned connections are untouched", () => {
  test("an inline database connection runs anything for anyone", async () => {
    session = stranger;
    const own = { id: "mine", name: "Mine", type: "postgres", host: "localhost", password: "own" };
    expect(
      (await answer(await query(post("/api/db/query", { connection: own, sql: "DROP TABLE scratch" })))).status,
    ).toBe(200);
  });

  test("an inline resource connection works, but may not claim a managed id", async () => {
    session = stranger;
    const own = { id: "my-bucket", name: "Mine", type: "s3", createdAt: "t" };
    expect((await answer(await tree(post("/api/resources/tree", { connection: own })))).status).toBe(200);
    const claimed = await answer(
      await tree(post("/api/resources/tree", { connection: { ...own, id: "managed:reports" } })),
    );
    expect(claimed.status).toBe(400);
    expect(claimed.body.error).toContain("reserved");
  });
});
