import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { NextRequest } from "next/server";
import { installAccessStore } from "../../helpers/access-store";
import { installAuthMock } from "../../helpers/auth-mock";

/**
 * The admin access API (StorageBase fork) on a real SQLite fork store: the admin gate on every
 * route, each CRUD path and its audit event, write-only secrets, test connection with the stored
 * secrets filled in, the sign-in switch and the access preview. A credential must never appear in
 * any response or audit line.
 */

const handle = installAccessStore();

let session: { role: string; username: string } | null = { role: "admin", username: "root" };
installAuthMock({ getSession: () => session });

const testManagedConfig = mock(
  async (..._args: unknown[]): Promise<{ success: boolean; message: string; latencyMs?: number }> => ({
    success: true,
    message: "Connected",
    latencyMs: 3,
  }),
);
mock.module("@/lib/access/connection-test", () => ({ testManagedConfig }));

const groups = await import("@/app/api/admin/access/groups/route");
const bindings = await import("@/app/api/admin/access/bindings/route");
const connections = await import("@/app/api/admin/access/connections/route");
const connectionTest = await import("@/app/api/admin/access/connections/test/route");
const authSettings = await import("@/app/api/admin/access/auth-settings/route");
const preview = await import("@/app/api/admin/access/preview/route");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { readSecret } = await import("@/lib/storage/encryption");

const SECRET = "managed-db-s3cret";

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://studio.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: typeof body === "string" ? body : JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const ENTRA_ENV = ["STORAGEBASE_ENTRA_TENANT_ID", "STORAGEBASE_ENTRA_CLIENT_ID", "STORAGEBASE_ENTRA_CLIENT_SECRET"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  await handle.reset();
  session = { role: "admin", username: "root" };
  getServerAuditBuffer().clear();
  clearRateLimitState();
  testManagedConfig.mockClear();
  for (const name of ENTRA_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of ENTRA_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  // Nothing an admin did in a test may have put a credential on the trail.
  expect(JSON.stringify(getServerAuditBuffer().getAll())).not.toContain(SECRET);
});

describe("the admin gate", () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ["GET groups", () => groups.GET(req("GET", "/api/admin/access/groups"))],
    ["POST groups", () => groups.POST(req("POST", "/api/admin/access/groups", { name: "x" }))],
    ["PUT groups", () => groups.PUT(req("PUT", "/api/admin/access/groups", { id: "x" }))],
    ["DELETE groups", () => groups.DELETE(req("DELETE", "/api/admin/access/groups?id=x"))],
    ["GET bindings", () => bindings.GET(req("GET", "/api/admin/access/bindings"))],
    ["POST bindings", () => bindings.POST(req("POST", "/api/admin/access/bindings", {}))],
    ["DELETE bindings", () => bindings.DELETE(req("DELETE", "/api/admin/access/bindings?id=x"))],
    ["GET connections", () => connections.GET(req("GET", "/api/admin/access/connections"))],
    ["POST connections", () => connections.POST(req("POST", "/api/admin/access/connections", {}))],
    ["PUT connections", () => connections.PUT(req("PUT", "/api/admin/access/connections", {}))],
    ["DELETE connections", () => connections.DELETE(req("DELETE", "/api/admin/access/connections?id=x"))],
    ["POST test", () => connectionTest.POST(req("POST", "/api/admin/access/connections/test", {}))],
    ["GET auth-settings", () => authSettings.GET(req("GET", "/api/admin/access/auth-settings"))],
    ["POST auth-settings", () => authSettings.POST(req("POST", "/api/admin/access/auth-settings", {}))],
    ["POST preview", () => preview.POST(req("POST", "/api/admin/access/preview", {}))],
  ];

  test.each(calls)("%s: 401 without a session, 403 for a user, and nothing written", async (_name, call) => {
    session = null;
    expect((await call()).status).toBe(401);
    session = { role: "user", username: "bob" };
    expect((await call()).status).toBe(403);
    expect(await handle.store.listRecords("access-group")).toEqual([]);
  });
});

describe("groups", () => {
  test("create, list with counts, update, delete — each audited", async () => {
    const created = await groups.POST(req("POST", "/api/admin/access/groups", { id: "payments", name: "Payments" }));
    expect(created.status).toBe(201);
    await bindings.POST(
      req("POST", "/api/admin/access/bindings", {
        appRoleValue: "Team.Payments.Read",
        groupId: "payments",
        permission: "read",
      }),
    );
    const listed = await json(await groups.GET(req("GET", "/api/admin/access/groups")));
    expect(listed).toMatchObject({
      storeAvailable: true,
      groups: [{ id: "payments", connectionCount: 0, bindingCount: 1 }],
    });
    const updated = await json(
      await groups.PUT(req("PUT", "/api/admin/access/groups", { id: "payments", name: "Payments Team" })),
    );
    expect(updated).toMatchObject({ group: { name: "Payments Team" } });
    const deleted = await json(await groups.DELETE(req("DELETE", "/api/admin/access/groups?id=payments")));
    expect(deleted).toMatchObject({ removedBindings: 1, detachedConnections: 0 });
    expect(
      getServerAuditBuffer()
        .getAll()
        .filter((event) => event.type === "access_config")
        .map((event) => event.action),
    ).toEqual(["group.create", "binding.create", "group.update", "group.delete"]);
  });

  test("the caller's mistakes are 400s with the field, a missing id 404, a DELETE without ?id= 400", async () => {
    expect((await groups.POST(req("POST", "/api/admin/access/groups", "{not json"))).status).toBe(400);
    expect(await json(await groups.POST(req("POST", "/api/admin/access/groups", "[1]")))).toMatchObject({
      error: "The request body must be a JSON object",
    });
    expect((await groups.PUT(req("PUT", "/api/admin/access/groups", { id: "missing", name: "x" }))).status).toBe(404);
    expect(await json(await groups.DELETE(req("DELETE", "/api/admin/access/groups")))).toMatchObject({
      error: 'The "id" query parameter is required',
    });
  });

  test("without server storage every list says so and every write refuses", async () => {
    handle.mode = "none";
    for (const response of [
      await groups.GET(req("GET", "/api/admin/access/groups")),
      await bindings.GET(req("GET", "/api/admin/access/bindings")),
      await connections.GET(req("GET", "/api/admin/access/connections")),
    ]) {
      expect(await json(response)).toMatchObject({
        storeAvailable: false,
        message: expect.stringContaining("STORAGE_PROVIDER"),
      });
    }
    const refused = await groups.POST(req("POST", "/api/admin/access/groups", { name: "x" }));
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ code: "ACCESS_STORE_UNAVAILABLE" });
  });
});

describe("bindings", () => {
  test("upsert reports created then replaced, lists with the group name and the seen roles, deletes", async () => {
    await groups.POST(req("POST", "/api/admin/access/groups", { id: "payments", name: "Payments" }));
    await handle.store.setSetting("access:seen-roles", [{ value: "Team.Payments.Read", lastSeenAt: "t" }], "sign-in");
    const body = { appRoleValue: "Team.Payments.Read", groupId: "payments", permission: "read" };
    const first = await bindings.POST(req("POST", "/api/admin/access/bindings", body));
    expect(first.status).toBe(201);
    const second = await bindings.POST(req("POST", "/api/admin/access/bindings", { ...body, permission: "write" }));
    expect(second.status).toBe(200);
    expect(await json(second)).toMatchObject({ replaced: true, binding: { permission: "write" } });
    const listed = await json(await bindings.GET(req("GET", "/api/admin/access/bindings")));
    expect(listed).toMatchObject({
      bindings: [{ appRoleValue: "Team.Payments.Read", groupName: "Payments" }],
      seenRoles: [{ value: "Team.Payments.Read" }],
    });
    const id = (listed.bindings as Array<{ id: string }>)[0].id;
    expect((await bindings.DELETE(req("DELETE", `/api/admin/access/bindings?id=${id}`))).status).toBe(200);
    expect(
      getServerAuditBuffer()
        .getAll()
        .map((event) => event.action),
    ).toEqual(expect.arrayContaining(["binding.create", "binding.update", "binding.delete"]));
  });

  test("a binding to a group that was deleted is listed by its id", async () => {
    await handle.store.putRecord(
      "access-binding",
      "b",
      { id: "b", appRoleValue: "A", groupId: "gone", permission: "read", createdAt: "t", createdBy: "r" },
      "r",
    );
    const listed = await json(await bindings.GET(req("GET", "/api/admin/access/bindings")));
    expect(listed).toMatchObject({ bindings: [{ groupName: "gone" }] });
  });
});

describe("managed connections", () => {
  async function createOrders(): Promise<Record<string, unknown>> {
    await groups.POST(req("POST", "/api/admin/access/groups", { id: "payments", name: "Payments" }));
    const res = await connections.POST(
      req("POST", "/api/admin/access/connections", {
        id: "orders",
        kind: "database",
        type: "postgres",
        name: "Orders",
        groupIds: ["payments"],
        config: { host: "db.internal", port: 5432, user: "reader", password: SECRET },
      }),
    );
    expect(res.status).toBe(201);
    return json(res);
  }

  test("create answers the admin view: no secret, which secrets are set, and the id users address it by", async () => {
    const created = await createOrders();
    expect(created.connection).toMatchObject({
      id: "orders",
      clientId: "seed:m_orders",
      groupNames: ["Payments"],
      config: { host: "db.internal", port: 5432, user: "reader" },
      secretsSet: ["password"],
    });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    const listed = await connections.GET(req("GET", "/api/admin/access/connections"));
    expect(JSON.stringify(await json(listed))).not.toContain(SECRET);
    expect(
      getServerAuditBuffer()
        .getAll()
        .find((event) => event.action === "connection.create"),
    ).toMatchObject({
      type: "managed_connection",
      target: "seed:m_orders",
    });
  });

  test("update keeps a blank secret, and delete removes the connection; resources are addressed as managed:", async () => {
    await createOrders();
    const updated = await json(
      await connections.PUT(
        req("PUT", "/api/admin/access/connections", { id: "orders", config: { host: "db2", password: "" } }),
      ),
    );
    expect(updated.connection).toMatchObject({ config: { host: "db2" }, secretsSet: ["password"] });
    const [record] = await handle.store.listRecords<{ config: { password: string } }>("access-connection");
    expect(readSecret(record.config.password)).toEqual({ kind: "decrypted", value: SECRET });

    const resource = await json(
      await connections.POST(
        req("POST", "/api/admin/access/connections", {
          id: "vault",
          kind: "resource",
          type: "azure-key-vault",
          name: "Vault",
        }),
      ),
    );
    expect(resource.connection).toMatchObject({ clientId: "managed:vault" });
    await connections.PUT(req("PUT", "/api/admin/access/connections", { id: "vault", name: "Vault 2" }));
    expect(await json(await connections.DELETE(req("DELETE", "/api/admin/access/connections?id=vault")))).toEqual({
      deleted: "vault",
    });
    expect(await json(await connections.DELETE(req("DELETE", "/api/admin/access/connections?id=orders")))).toEqual({
      deleted: "orders",
    });
    expect(await handle.store.listRecords("access-connection")).toEqual([]);
  });

  test("test connection fills the blank secrets from the stored record, and is audited without them", async () => {
    await createOrders();
    const res = await connectionTest.POST(
      req("POST", "/api/admin/access/connections/test", {
        id: "orders",
        kind: "database",
        type: "postgres",
        name: "Orders",
        config: { host: "db3" },
      }),
    );
    expect(await json(res)).toEqual({ success: true, message: "Connected", latencyMs: 3 });
    const [kind, type, name, config] = testManagedConfig.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, string>,
    ];
    expect([kind, type, name, config.host]).toEqual(["database", "postgres", "Orders", "db3"]);
    expect(readSecret(config.password)).toEqual({ kind: "decrypted", value: SECRET });
    expect(
      getServerAuditBuffer()
        .getAll()
        .find((event) => event.action === "connection.test"),
    ).toMatchObject({ target: "orders" });
  });

  test("a draft is tested without an id; a bad kind or type is a 400, an unknown id a 404; a failure is audited", async () => {
    testManagedConfig.mockImplementationOnce(async () => ({ success: false, message: "refused" }));
    const draft = await connectionTest.POST(
      req("POST", "/api/admin/access/connections/test", { kind: "resource", type: "s3", config: "not an object" }),
    );
    expect(await json(draft)).toEqual({ success: false, message: "refused" });
    expect(testManagedConfig.mock.calls[0].slice(0, 4)).toEqual(["resource", "s3", "test", {}]);
    expect(getServerAuditBuffer().getAll().at(-1)).toMatchObject({ target: "draft:s3", result: "failure" });
    expect(
      (await connectionTest.POST(req("POST", "/api/admin/access/connections/test", { kind: "x", type: "s3" }))).status,
    ).toBe(400);
    expect(
      (await connectionTest.POST(req("POST", "/api/admin/access/connections/test", { kind: "database" }))).status,
    ).toBe(400);
    expect(
      (
        await connectionTest.POST(
          req("POST", "/api/admin/access/connections/test", { id: "nope", kind: "database", type: "postgres" }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("the sign-in switch", () => {
  test("GET answers the settings, no Entra summary when unconfigured, and the store's presence", async () => {
    expect(await json(await authSettings.GET(req("GET", "/api/admin/access/auth-settings")))).toEqual({
      settings: { entraEnabled: false, localLogin: "enabled", source: "env" },
      entra: null,
      test: null,
      storeAvailable: true,
    });
    handle.mode = "none";
    expect(await json(await authSettings.GET(req("GET", "/api/admin/access/auth-settings")))).toMatchObject({
      storeAvailable: false,
      test: null,
    });
  });

  test("a configured Entra is summarised without its secret; a broken one says why", async () => {
    process.env.STORAGEBASE_ENTRA_TENANT_ID = "00000000-0000-4000-8000-000000000000";
    process.env.STORAGEBASE_ENTRA_CLIENT_ID = "client";
    process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "entra-client-secret";
    const answer = await json(await authSettings.GET(req("GET", "/api/admin/access/auth-settings")));
    expect(answer.entra).toEqual({
      tenantId: "00000000-0000-4000-8000-000000000000",
      clientId: "client",
      redirectUri: null,
      adminRoles: ["StorageBase.Admin"],
      allowedRoles: [],
      sessionHours: 8,
      error: null,
    });
    expect(JSON.stringify(answer)).not.toContain("entra-client-secret");
    process.env.STORAGEBASE_ENTRA_TENANT_ID = "contoso.example";
    expect((await json(await authSettings.GET(req("GET", "/api/admin/access/auth-settings")))).entra).toEqual({
      error: expect.stringContaining("GUID"),
    });
  });

  test("POST saves through the rails and audits before and after", async () => {
    const saved = await json(
      await authSettings.POST(
        req("POST", "/api/admin/access/auth-settings", { entraEnabled: false, localLogin: "admin-only" }),
      ),
    );
    expect(saved).toMatchObject({ settings: { localLogin: "admin-only", source: "store", updatedBy: "root" } });
    const event = getServerAuditBuffer()
      .getAll()
      .find((candidate) => candidate.type === "auth_settings_changed");
    expect(JSON.parse(event?.details as string)).toEqual({
      before: { entraEnabled: false, localLogin: "enabled" },
      after: { entraEnabled: false, localLogin: "admin-only" },
    });
    expect(
      (
        await authSettings.POST(
          req("POST", "/api/admin/access/auth-settings", { entraEnabled: true, localLogin: "enabled" }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("access preview", () => {
  test("shows what a set of app roles would reach, as a user by default and as an admin on request", async () => {
    await groups.POST(req("POST", "/api/admin/access/groups", { id: "payments", name: "Payments" }));
    await bindings.POST(
      req("POST", "/api/admin/access/bindings", {
        appRoleValue: "Team.Payments.Read",
        groupId: "payments",
        permission: "read",
      }),
    );
    await connections.POST(
      req("POST", "/api/admin/access/connections", {
        id: "orders",
        kind: "database",
        type: "postgres",
        name: "Orders",
        groupIds: ["payments"],
      }),
    );
    await connections.POST(
      req("POST", "/api/admin/access/connections", {
        id: "vault",
        kind: "resource",
        type: "azure-key-vault",
        name: "Vault",
      }),
    );
    const asMember = await json(
      await preview.POST(req("POST", "/api/admin/access/preview", { roles: ["Team.Payments.Read"] })),
    );
    expect(asMember).toEqual({
      subject: { role: "user", appRoles: ["Team.Payments.Read"] },
      databases: [
        {
          id: "orders",
          name: "Orders",
          type: "postgres",
          permission: "read",
          via: "binding",
          roles: ["Team.Payments.Read"],
          groups: ["Payments"],
        },
      ],
      resources: [],
    });
    const asAdmin = await json(
      await preview.POST(req("POST", "/api/admin/access/preview", { roles: [], studioRole: "admin" })),
    );
    expect((asAdmin.resources as unknown[]).length).toBe(1);
    handle.mode = "none";
    expect(await json(await preview.POST(req("POST", "/api/admin/access/preview", {})))).toMatchObject({
      databases: [],
      resources: [],
    });
  });
});
