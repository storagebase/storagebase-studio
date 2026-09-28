import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAccessStore } from "../../../helpers/access-store";

/**
 * Resolution of managed connections for a signed-in user (StorageBase fork), against a real SQLite
 * fork store: who sees what, what the served rows carry (and never carry), what a resolved
 * connection carries, and that a Helm seed's `roles:` list matches app roles through the same hook.
 */

const handle = installAccessStore();
const store = await import("@/lib/access/store");
const resolve = await import("@/lib/access/resolve");
const { resolveSeedForSession } = await import("@/lib/access/seed-hooks");
const { grantOf } = await import("@/lib/access/grant");
const { resetManagedUseTracking } = await import("@/lib/access/audit");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { resetCache } = await import("@/lib/seed");

const reader = { role: "user", username: "alice", appRoles: ["Team.Payments.Read"] };
const writer = { role: "user", username: "bob", appRoles: ["Team.Payments.Write"] };
const stranger = { role: "user", username: "eve", appRoles: ["Team.Other.Read"] };
const admin = { role: "admin", username: "root" };

const SECRETS = ["db-s3cret", "vault-client-secret"];

beforeEach(async () => {
  await handle.reset();
  getServerAuditBuffer().clear();
  clearRateLimitState();
  resetManagedUseTracking();
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
      config: {
        host: "db.internal",
        port: 5432,
        user: "reader",
        password: SECRETS[0],
        database: "orders",
        environment: "production",
      },
    },
    "root",
  );
  await store.createManagedConnection(
    {
      id: "vault",
      kind: "resource",
      type: "azure-key-vault",
      name: "Team vault",
      groupIds: ["payments"],
      config: { vaultName: "team", tenantId: "t", clientId: "c", clientSecret: SECRETS[1], color: "#10B981" },
    },
    "root",
  );
  await store.createManagedConnection({ id: "loose", kind: "database", type: "mysql", name: "Loose" }, "root");
});

describe("listing", () => {
  test("a member sees the group's connections at their permission, presentation fields only", async () => {
    const rows = await resolve.listManagedDatabaseRows(reader);
    expect(rows).toEqual([
      {
        database: "orders",
        environment: "production",
        id: "seed:m_orders",
        seedId: "m_orders",
        name: "Orders",
        type: "postgres",
        createdAt: expect.any(String),
        managed: true,
        roles: [],
        permission: "read",
        groupNames: ["Payments"],
      },
    ]);
    const resources = await resolve.listManagedResourceRows(writer);
    expect(resources).toEqual([
      {
        color: "#10B981",
        id: "managed:vault",
        name: "Team vault",
        type: "azure-key-vault",
        createdAt: expect.any(String),
        managed: true,
        permission: "write",
        groupNames: ["Payments"],
      },
    ]);
  });

  test("served rows never carry a credential, a host, a user or an address", async () => {
    const served = JSON.stringify([
      ...(await resolve.listManagedDatabaseRows(admin)),
      ...(await resolve.listManagedResourceRows(admin)),
    ]);
    for (const leak of [...SECRETS, "db.internal", "reader", "tenantId", "clientId", "vaultName", "5432"]) {
      expect(served).not.toContain(leak);
    }
  });

  test("a non-member sees nothing; an admin sees everything, groupless ones included, sorted by name", async () => {
    expect(await resolve.listManagedDatabaseRows(stranger)).toEqual([]);
    expect(await resolve.listManagedResourceRows(stranger)).toEqual([]);
    const rows = await resolve.listManagedDatabaseRows(admin);
    expect(rows.map((row) => [row.name, row.permission, row.groupNames])).toEqual([
      ["Loose", "admin", []],
      ["Orders", "admin", ["Payments"]],
    ]);
  });

  test("no server storage lists nothing; a broken store lists nothing and says so in the log", async () => {
    handle.mode = "none";
    expect(await resolve.listManagedDatabaseRows(admin)).toEqual([]);
    expect(await resolve.listManagedResourceRows(admin)).toEqual([]);
    handle.mode = "broken";
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(await resolve.listManagedDatabaseRows(admin)).toEqual([]);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    await expect(resolve.listManagedResourceRows(admin)).rejects.toThrow("database is locked");
  });

  test("a group that disappeared from under a connection is named by id", async () => {
    const state = await store.loadAccessState(handle.store);
    const visible = resolve.visibleConnections(reader, { ...state, groups: [] }, "database");
    expect(visible[0].grant.groupNames).toEqual(["payments"]);
    expect(visible[0].groupNames).toEqual([]);
  });
});

describe("database resolution", () => {
  test("a member gets the decrypted connection with its grant, and the use is audited once", async () => {
    const connection = await resolve.resolveManagedDatabaseSeed("m_orders", reader);
    expect(connection).toMatchObject({
      id: "seed:m_orders",
      name: "Orders",
      type: "postgres",
      host: "db.internal",
      password: SECRETS[0],
      managed: true,
      seedId: "m_orders",
    });
    expect(connection?.createdAt).toBeInstanceOf(Date);
    expect(grantOf(connection)).toMatchObject({
      permission: "read",
      roles: ["Team.Payments.Read"],
      groupNames: ["Payments"],
    });
    await resolve.resolveManagedDatabaseSeed("m_orders", reader);
    const uses = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "managed_connection");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      user: "alice",
      permission: "read",
      grantedBy: "Team.Payments.Read",
      accessGroups: "Payments",
    });
  });

  test("a non-member and a missing id both answer null, and only the probe of a real one is recorded", async () => {
    expect(await resolve.resolveManagedDatabaseSeed("m_orders", stranger)).toBeNull();
    expect(await resolve.resolveManagedDatabaseSeed("m_missing", stranger)).toBeNull();
    const denials = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "permission_denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ reason: "access_not_granted", target: "seed:m_orders", user: "eve" });
  });

  test("a resource id, a Helm-style id, or no store resolves to nothing here", async () => {
    expect(await resolve.resolveManagedDatabaseSeed("m_vault", admin)).toBeNull();
    expect(await resolve.resolveManagedDatabaseSeed("orders", admin)).toBeNull();
    handle.mode = "none";
    expect(await resolve.resolveManagedDatabaseSeed("m_orders", admin)).toBeNull();
  });

  test("an admin resolves a groupless connection through the bypass", async () => {
    const connection = await resolve.resolveManagedDatabaseSeed("m_loose", admin);
    expect(grantOf(connection)).toMatchObject({ permission: "admin", via: "admin-bypass" });
  });
});

describe("resource resolution", () => {
  test("a member gets the decrypted connection with its grant", async () => {
    const connection = await resolve.resolveManagedResource("managed:vault", writer);
    expect(connection).toMatchObject({ id: "managed:vault", type: "azure-key-vault", clientSecret: SECRETS[1] });
    expect(grantOf(connection)?.permission).toBe("write");
  });

  test("a non-member, a missing id, a database id, a foreign prefix and no store all answer null", async () => {
    expect(await resolve.resolveManagedResource("managed:vault", stranger)).toBeNull();
    expect(await resolve.resolveManagedResource("managed:missing", admin)).toBeNull();
    expect(await resolve.resolveManagedResource("managed:orders", admin)).toBeNull();
    expect(await resolve.resolveManagedResource("vault", admin)).toBeNull();
    handle.mode = "none";
    expect(await resolve.resolveManagedResource("managed:vault", admin)).toBeNull();
  });
});

describe("the seed hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-roles-"));
  const path = join(dir, "seeds.yaml");
  writeFileSync(
    path,
    [
      'version: "1"',
      "connections:",
      "  - id: team-db",
      "    name: Team DB",
      "    type: postgres",
      "    host: localhost",
      "    roles: [Team.Payments.Read]",
    ].join("\n"),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("managed ids resolve through the bindings, and a Helm seed's roles match app roles", async () => {
    process.env.SEED_CONFIG_PATH = path;
    resetCache();
    try {
      expect((await resolveSeedForSession("m_orders", reader))?.name).toBe("Orders");
      expect((await resolveSeedForSession("team-db", reader))?.name).toBe("Team DB");
      expect(await resolveSeedForSession("team-db", stranger)).toBeNull();
      expect(await resolveSeedForSession("team-db", { role: "user", username: "local" })).toBeNull();
    } finally {
      delete process.env.SEED_CONFIG_PATH;
      resetCache();
    }
  });
});
