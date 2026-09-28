import { beforeEach, describe, expect, mock, test } from "bun:test";
import { installAccessStore } from "../../../helpers/access-store";
import { memoryStorageProvider, type MemoryStorageProvider } from "../../../helpers/memory-storage-provider";

/**
 * A user's own connections with server-held credentials: save, preview, forget, migrate and
 * resolve, against a real SQLite fork store and the real storage wrapper over an in-memory
 * provider. The properties that matter: no answer carries a secret, a secret follows only the
 * target it was saved for, and one user can never reach another's.
 */

const handle = installAccessStore();
let inner: MemoryStorageProvider;
let provider: unknown;
let storageOn = true;

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => (storageOn ? provider : null),
  getStorageProviderType: () => (storageOn ? "sqlite" : "local"),
}));

const { withServerHeldSecrets } = await import("@/lib/user-connections/provider");
const server = await import("@/lib/user-connections/server");
const { getServerAuditBuffer } = await import("@/lib/audit");

beforeEach(async () => {
  await handle.reset();
  inner = memoryStorageProvider();
  provider = withServerHeldSecrets(inner);
  storageOn = true;
  getServerAuditBuffer().clear();
});

const PG = {
  id: "c1",
  name: "orders",
  type: "postgres",
  host: "db",
  port: 5432,
  user: "app",
  password: "pw-1",
  sshTunnel: { enabled: true, host: "bastion", port: 22, username: "ops", authMethod: "password", password: "ssh-1" },
};
const KV = { id: "r1", name: "vault", type: "hashicorp-vault", endpoint: "https://vault:8200", token: "tok-1" };

/** PG as the browser holds it once saved: every secret blank. */
const PG_BLANK = { ...PG, password: "", sshTunnel: { ...PG.sshTunnel, password: "" } };

function everything(): string {
  return JSON.stringify([...inner.rows.values()]);
}

describe("saveUserConnection", () => {
  test("answers the row without secrets, stores the row without secrets, and holds them sealed", async () => {
    const saved = await server.saveUserConnection("alice", "database", PG);
    expect(saved).not.toHaveProperty("password");
    expect((saved.sshTunnel as Record<string, unknown>).password).toBeUndefined();
    expect(saved.savedSecrets).toEqual(["password", "sshTunnel.password"]);
    expect(everything()).not.toContain("pw-1");
    expect(everything()).not.toContain("ssh-1");
    const { secretRecordKind } = await import("@/lib/user-connections/store");
    const atRest = JSON.stringify(await handle.store.listRecords(secretRecordKind("alice", "database")));
    expect(atRest).toContain("sshTunnel.password");
    expect(atRest).not.toContain("pw-1");
    const resolved = await server.resolveUserConnection("alice", "database", "user:c1");
    expect(resolved?.password).toBe("pw-1");
    expect(resolved).toMatchObject({ sshTunnel: expect.objectContaining({ password: "ssh-1" }) });
  });

  test("blank keeps, clear removes, and a changed target drops what it is not given", async () => {
    await server.saveUserConnection("alice", "database", PG);
    const kept = await server.saveUserConnection("alice", "database", { ...PG_BLANK, name: "renamed" });
    expect(kept.savedSecrets).toEqual(["password", "sshTunnel.password"]);
    const cleared = await server.saveUserConnection("alice", "database", PG_BLANK, ["password"]);
    expect(cleared.savedSecrets).toEqual(["sshTunnel.password"]);
    const moved = await server.saveUserConnection("alice", "database", { ...PG_BLANK, host: "other" });
    expect(moved.savedSecrets).toEqual([]);
    expect(await server.resolveUserConnection("alice", "database", "user:c1")).not.toHaveProperty("password");
    const retyped = await server.saveUserConnection("alice", "database", {
      ...PG_BLANK,
      host: "other",
      password: "pw-2",
    });
    expect(retyped.savedSecrets).toEqual(["password"]);
    // One row, updated in place.
    expect(inner.rows.get("alice\u0000connections")).toHaveLength(1);
  });

  test("resource connections save the same way", async () => {
    const saved = await server.saveUserConnection("alice", "resource", KV);
    expect(saved.savedSecrets).toEqual(["token"]);
    expect(saved).not.toHaveProperty("token");
    expect((await server.resolveUserConnection("alice", "resource", "user:r1"))?.token).toBe("tok-1");
  });

  test("refuses what it cannot keep", async () => {
    await expect(server.saveUserConnection("alice", "database", null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(server.saveUserConnection("alice", "database", [])).rejects.toMatchObject({ statusCode: 400 });
    await expect(server.saveUserConnection("alice", "database", { ...PG, id: "" })).rejects.toThrow("connection.id");
    await expect(server.saveUserConnection("alice", "database", { ...PG, id: "x".repeat(129) })).rejects.toThrow(
      "connection.id",
    );
    await expect(server.saveUserConnection("alice", "database", { ...PG, id: "user:c1" })).rejects.toThrow("reserved");
    await expect(server.saveUserConnection("alice", "database", { ...PG, type: "s3" })).rejects.toThrow(
      "not a database type",
    );
    await expect(server.saveUserConnection("alice", "resource", { ...KV, type: "postgres" })).rejects.toThrow(
      "not a resource type",
    );
    await expect(server.saveUserConnection("alice", "database", PG, "password")).rejects.toThrow("clear:");
    await expect(server.saveUserConnection("alice", "database", PG, [1])).rejects.toThrow("clear:");
  });

  test("without server storage it refuses with the reason", async () => {
    storageOn = false;
    await expect(server.saveUserConnection("alice", "database", PG)).rejects.toBeInstanceOf(
      server.UserConnectionStoreUnavailableError,
    );
    await expect(server.saveUserConnection("alice", "database", PG)).rejects.toMatchObject({
      statusCode: 409,
      message: server.USER_STORE_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("previewUserConnection", () => {
  test("fills in the stored secrets while the target holds, and never persists", async () => {
    await server.saveUserConnection("alice", "database", PG);
    const preview = await server.previewUserConnection("alice", "database", { ...PG, password: "", name: "draft" });
    expect(preview.password).toBe("pw-1");
    expect(preview.name).toBe("draft");
    const cleared = await server.previewUserConnection("alice", "database", { ...PG, password: "" }, ["password"]);
    expect(cleared).not.toHaveProperty("password");
    const elsewhere = await server.previewUserConnection("alice", "database", { ...PG_BLANK, host: "evil" });
    expect(elsewhere).not.toHaveProperty("password");
    expect((elsewhere.sshTunnel as Record<string, unknown>).password).toBeUndefined();
    expect((inner.rows.get("alice\u0000connections") as Record<string, unknown>[])[0].name).toBe("orders");
  });
});

describe("forgetUserConnection", () => {
  test("removes the stored secrets; a missing one is fine; a bad id is refused", async () => {
    await server.saveUserConnection("alice", "database", PG);
    await server.forgetUserConnection("alice", "database", "c1");
    await server.forgetUserConnection("alice", "database", "c1");
    expect(await server.resolveUserConnection("alice", "database", "user:c1")).not.toHaveProperty("password");
    await expect(server.forgetUserConnection("alice", "database", "")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("migrateUserConnections", () => {
  test("adds the browser's unknown rows, moves their secrets, audits the count, and is idempotent", async () => {
    const first = await server.migrateUserConnections("alice", "database", [PG, "junk", { name: "no id" }]);
    expect(first.migrated).toBe(1);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].savedSecrets).toEqual(["password", "sshTunnel.password"]);
    expect(JSON.stringify(first)).not.toContain("pw-1");
    const again = await server.migrateUserConnections("alice", "database", [first.rows[0]]);
    expect(again.migrated).toBe(0);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "connection_secrets_migrated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user: "alice", target: "database", details: "1 connection(s)" });
    expect(JSON.stringify(events)).not.toContain("pw-1");
  });

  test("a stale browser copy pointing elsewhere does not re-target a saved connection", async () => {
    await server.saveUserConnection("alice", "database", PG);
    const stale = await server.migrateUserConnections("alice", "database", [{ ...PG, host: "evil", password: "x" }]);
    expect(stale.migrated).toBe(0);
    expect((await server.resolveUserConnection("alice", "database", "user:c1"))?.password).toBe("pw-1");
    expect(stale.rows[0].host).toBe("db");
  });

  test("a matching browser copy gives its secrets up to the server's row", async () => {
    await server.saveUserConnection("alice", "database", { ...PG, password: "" });
    const moved = await server.migrateUserConnections("alice", "database", [PG]);
    expect(moved.migrated).toBe(1);
    expect((await server.resolveUserConnection("alice", "database", "user:c1"))?.password).toBe("pw-1");
  });

  test("refuses a non-list", async () => {
    await expect(server.migrateUserConnections("alice", "database", {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("resolveUserConnection", () => {
  test("other ids, no user, no storage and unknown ids resolve to nothing", async () => {
    await server.saveUserConnection("alice", "database", PG);
    expect(await server.resolveUserConnection("alice", "database", "seed:c1")).toBeNull();
    expect(await server.resolveUserConnection(undefined, "database", "user:c1")).toBeNull();
    expect(await server.resolveUserConnection("alice", "database", "user:nope")).toBeNull();
    storageOn = false;
    expect(await server.resolveUserConnection("alice", "database", "user:c1")).toBeNull();
  });

  test("user B cannot reach user A's connection by its id", async () => {
    await server.saveUserConnection("alice", "database", PG);
    expect(await server.resolveUserConnection("bob", "database", "user:c1")).toBeNull();
    // Even when bob holds a row with the same id, alice's secrets are not his.
    await server.saveUserConnection("bob", "database", { ...PG, password: "" });
    expect(await server.resolveUserConnection("bob", "database", "user:c1")).not.toHaveProperty("password");
  });

  test("a row re-pointed behind the save is refused instead of being handed the old secret", async () => {
    await server.saveUserConnection("alice", "database", PG);
    await inner.setCollection("alice", "connections", [{ ...PG_BLANK, host: "evil" }] as never);
    await expect(server.resolveUserConnection("alice", "database", "user:c1")).rejects.toMatchObject({
      statusCode: 409,
      message: server.TARGET_CHANGED_MESSAGE,
    });
  });

  test("a secret that no longer opens is left out, and the row still resolves", async () => {
    await server.saveUserConnection("alice", "database", PG);
    const kind = (await import("@/lib/user-connections/store")).secretRecordKind("alice", "database");
    const [record] = await handle.store.listRecords<Record<string, unknown>>(kind);
    await handle.store.putRecord(
      kind,
      "c1",
      { ...record, secrets: { ...(record.secrets as object), password: "v1:dead:beef:cafe" } },
      "t",
    );
    const resolved = await server.resolveUserConnection("alice", "database", "user:c1");
    expect(resolved).not.toHaveProperty("password");
    expect(resolved).toMatchObject({ sshTunnel: expect.objectContaining({ password: "ssh-1" }) });
  });

  test("isUserConnectionFamily names the two families", () => {
    expect(server.isUserConnectionFamily("database")).toBe(true);
    expect(server.isUserConnectionFamily("resource")).toBe(true);
    expect(server.isUserConnectionFamily("blob")).toBe(false);
  });
});
