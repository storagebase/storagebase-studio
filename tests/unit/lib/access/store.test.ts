import { describe, test, expect, beforeEach } from "bun:test";
import { installAccessStore } from "../../../helpers/access-store";

/**
 * The access model's persistence against a real SQLite fork store: validation, the cascades, the
 * binding upsert, and — the part that matters most — that every credential is sealed at rest, a
 * blank secret keeps the stored one, null clears it, and an unopenable one is dropped rather than
 * re-sealed as if its ciphertext were a password.
 */

const handle = installAccessStore();
const store = await import("@/lib/access/store");
const { readSecret, encryptSecret, resetStorageEncryptionKey } = await import("@/lib/storage/encryption");
const { AccessStoreUnavailableError } = await import("@/lib/access/errors");

beforeEach(async () => {
  await handle.reset();
  resetStorageEncryptionKey();
});

async function group(id = "payments", name = "Payments") {
  return store.createGroup({ id, name, description: "Team data" }, "admin");
}

describe("the store's availability", () => {
  test("no server storage: reads say so, writes refuse with the reason", async () => {
    handle.mode = "none";
    expect(await store.openAccessStore()).toBeNull();
    const refused = await store.createGroup({ name: "x" }, "admin").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AccessStoreUnavailableError);
    expect((refused as Error).message).toContain("STORAGE_PROVIDER");
  });

  test("the empty state is empty", async () => {
    expect(await store.loadAccessState(handle.store)).toEqual(store.EMPTY_ACCESS_STATE);
  });
});

describe("groups", () => {
  test("create with a chosen id or a generated one, trimmed, with who and when", async () => {
    const chosen = await group();
    expect(chosen).toMatchObject({ id: "payments", name: "Payments", description: "Team data", createdBy: "admin" });
    const generated = await store.createGroup({ name: "  Ops  " }, "alice");
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.name).toBe("Ops");
    expect(generated).not.toHaveProperty("description");
  });

  test("names and ids are unique, and invalid input is refused with the field", async () => {
    await group();
    await expect(group("payments", "Other")).rejects.toThrow('A group with id "payments" already exists');
    await expect(group("other", "PAYMENTS")).rejects.toThrow('A group named "PAYMENTS" already exists');
    await expect(store.createGroup({ name: "" }, "admin")).rejects.toThrow("name: A name is required");
    await expect(store.createGroup({ id: "Bad Id", name: "x" }, "admin")).rejects.toThrow("id: An id is lowercase");
    await expect(store.createGroup("nope", "admin")).rejects.toMatchObject({ statusCode: 400 });
  });

  test("update renames, re-describes, clears a description, and refuses a taken name", async () => {
    await group();
    await group("ops", "Ops");
    const { before, after } = await store.updateGroup(
      { id: "payments", name: "Payments Team", description: "new" },
      "bob",
    );
    expect(before.name).toBe("Payments");
    expect(after).toMatchObject({ name: "Payments Team", description: "new", updatedBy: "bob" });
    const cleared = await store.updateGroup({ id: "payments", description: "" }, "bob");
    expect(cleared.after).not.toHaveProperty("description");
    expect(cleared.after.name).toBe("Payments Team");
    const untouched = await store.updateGroup({ id: "payments" }, "bob");
    expect(untouched.after.name).toBe("Payments Team");
    await expect(store.updateGroup({ id: "payments", name: "ops" }, "bob")).rejects.toThrow("already exists");
    await expect(store.updateGroup({ id: "missing", name: "x" }, "bob")).rejects.toMatchObject({ statusCode: 404 });
  });

  test("delete removes the group, its bindings and its membership, and says how many", async () => {
    await group();
    await group("ops", "Ops");
    await store.createBinding({ appRoleValue: "Team.Payments.Read", groupId: "payments", permission: "read" }, "admin");
    await store.createBinding({ appRoleValue: "Team.Ops.Read", groupId: "ops", permission: "read" }, "admin");
    await store.createManagedConnection(
      { id: "orders", kind: "database", type: "postgres", name: "Orders", groupIds: ["payments", "ops"] },
      "admin",
    );
    const result = await store.deleteGroup("payments", "admin");
    expect(result).toMatchObject({ removedBindings: 1, detachedConnections: 1 });
    const state = await store.loadAccessState(handle.store);
    expect(state.groups.map((g) => g.id)).toEqual(["ops"]);
    expect(state.bindings.map((b) => b.groupId)).toEqual(["ops"]);
    expect(state.connections[0].groupIds).toEqual(["ops"]);
    await expect(store.deleteGroup("payments", "admin")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("bindings", () => {
  test("create, then the same role and group again changes the permission instead of duplicating", async () => {
    await group();
    const first = await store.createBinding(
      { appRoleValue: "Team.Payments.Read", groupId: "payments", permission: "read" },
      "admin",
    );
    expect(first.replaced).toBeNull();
    const again = await store.createBinding(
      { appRoleValue: " team.payments.read ", groupId: "payments", permission: "write" },
      "bob",
    );
    expect(again.replaced?.permission).toBe("read");
    expect(again.binding).toMatchObject({
      id: first.binding.id,
      permission: "write",
      appRoleValue: "team.payments.read",
    });
    expect((await store.loadAccessState(handle.store)).bindings).toHaveLength(1);
  });

  test("refuses an unknown group, a bad permission, and role values with spaces or commas", async () => {
    await group();
    await expect(
      store.createBinding({ appRoleValue: "A", groupId: "missing", permission: "read" }, "a"),
    ).rejects.toThrow('groupId: group "missing" does not exist');
    await expect(
      store.createBinding({ appRoleValue: "A", groupId: "payments", permission: "owner" }, "a"),
    ).rejects.toThrow("permission");
    for (const appRoleValue of ["Team Payments", "a,b", "   "]) {
      await expect(
        store.createBinding({ appRoleValue, groupId: "payments", permission: "read" }, "a"),
      ).rejects.toMatchObject({
        statusCode: 400,
      });
    }
  });

  test("delete answers the deleted binding, and a missing one is 404", async () => {
    await group();
    const { binding } = await store.createBinding({ appRoleValue: "A", groupId: "payments", permission: "admin" }, "a");
    expect((await store.deleteBinding(binding.id)).appRoleValue).toBe("A");
    await expect(store.deleteBinding(binding.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("managed connections", () => {
  test("create seals every credential at rest and keeps only classified fields", async () => {
    await group();
    const record = await store.createManagedConnection(
      {
        id: "orders",
        kind: "database",
        type: "postgres",
        name: "Orders",
        groupIds: ["payments", "payments"],
        config: {
          host: "db.internal",
          port: 5432,
          user: "reader",
          password: "s3cret",
          database: "orders",
          id: "smuggled",
          managed: false,
          unknownField: "dropped",
          ssl: { mode: "require", clientKey: "PRIVATE", caCert: "CERT", junk: 1 },
          sshTunnel: {
            enabled: true,
            host: "bastion",
            port: 22,
            username: "u",
            authMethod: "password",
            password: "tunnelpw",
          },
        },
      },
      "admin",
    );
    expect(record.groupIds).toEqual(["payments"]);
    const config = record.config as Record<string, Record<string, unknown> | unknown>;
    expect(config).not.toHaveProperty("id");
    expect(config).not.toHaveProperty("managed");
    expect(config).not.toHaveProperty("unknownField");
    expect(config.host).toBe("db.internal");
    expect(readSecret(config.password as string)).toEqual({ kind: "decrypted", value: "s3cret" });
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.caCert).toBe("CERT");
    expect(ssl).not.toHaveProperty("junk");
    expect(readSecret(ssl.clientKey as string)).toEqual({ kind: "decrypted", value: "PRIVATE" });
    expect(readSecret((config.sshTunnel as Record<string, string>).password)).toEqual({
      kind: "decrypted",
      value: "tunnelpw",
    });
    // And on disk: the stored JSON carries no plaintext credential at all.
    const raw = JSON.stringify(await handle.store.listRecords("access-connection"));
    for (const secret of ["s3cret", "PRIVATE", "tunnelpw"]) expect(raw).not.toContain(secret);
  });

  test("resource connections seal their own credential fields", async () => {
    const record = await store.createManagedConnection(
      {
        kind: "resource",
        type: "s3",
        name: "Bucket",
        config: { region: "eu-west-1", accessKeyId: "AKIA", secretAccessKey: "SK" },
      },
      "admin",
    );
    expect(record.config.accessKeyId).toBe("AKIA");
    expect(readSecret(record.config.secretAccessKey as string)).toEqual({ kind: "decrypted", value: "SK" });
  });

  test("refuses an unknown type or group, a duplicate id, and non-scalar or oversized values", async () => {
    await expect(store.createManagedConnection({ kind: "database", type: "nope", name: "x" }, "a")).rejects.toThrow(
      'type: "nope" is not a database type',
    );
    await expect(store.createManagedConnection({ kind: "resource", type: "postgres", name: "x" }, "a")).rejects.toThrow(
      "is not a resource type",
    );
    await expect(
      store.createManagedConnection({ kind: "database", type: "postgres", name: "x", groupIds: ["missing"] }, "a"),
    ).rejects.toThrow('groupIds: group "missing" does not exist');
    await store.createManagedConnection({ id: "one", kind: "database", type: "postgres", name: "x" }, "a");
    await expect(
      store.createManagedConnection({ id: "one", kind: "database", type: "postgres", name: "y" }, "a"),
    ).rejects.toThrow("already exists");
    await expect(
      store.createManagedConnection({ kind: "database", type: "postgres", name: "x", config: { host: ["a"] } }, "a"),
    ).rejects.toThrow("config.host: must be a string, number or boolean");
    await expect(
      store.createManagedConnection(
        { kind: "database", type: "postgres", name: "x", config: { host: "h".repeat(70_000) } },
        "a",
      ),
    ).rejects.toThrow("config.host: value is too long");
    await expect(
      store.createManagedConnection(
        { kind: "database", type: "postgres", name: "x", config: { ssl: { mode: {} } } },
        "a",
      ),
    ).rejects.toThrow("config.ssl.mode");
  });

  test("update: blank keeps, a value replaces, null clears; the public config is replaced whole", async () => {
    await group();
    await store.createManagedConnection(
      {
        id: "orders",
        kind: "database",
        type: "postgres",
        name: "Orders",
        config: {
          host: "a",
          user: "reader",
          password: "one",
          sentinelPassword: "sp",
          ssl: { mode: "require", clientKey: "K" },
        },
      },
      "admin",
    );
    const kept = await store.updateManagedConnection(
      { id: "orders", config: { host: "b", password: "", ssl: { mode: "verify-full" } } },
      "bob",
    );
    expect(kept.after.config.host).toBe("b");
    expect(kept.after.config).not.toHaveProperty("user");
    expect(readSecret(kept.after.config.password as string)).toEqual({ kind: "decrypted", value: "one" });
    expect(readSecret((kept.after.config.ssl as Record<string, string>).clientKey)).toEqual({
      kind: "decrypted",
      value: "K",
    });
    expect(kept.after.updatedBy).toBe("bob");

    const replaced = await store.updateManagedConnection(
      {
        id: "orders",
        name: "Orders 2",
        config: { host: "b", password: "two", sentinelPassword: null },
        groupIds: ["payments"],
      },
      "bob",
    );
    expect(replaced.after.name).toBe("Orders 2");
    expect(replaced.after.groupIds).toEqual(["payments"]);
    expect(readSecret(replaced.after.config.password as string)).toEqual({ kind: "decrypted", value: "two" });
    expect(replaced.after.config).not.toHaveProperty("sentinelPassword");
    // Dropping the ssl block drops the key inside it: a TLS key for a transport the connection no longer uses.
    expect(replaced.after.config).not.toHaveProperty("ssl");

    const renamed = await store.updateManagedConnection({ id: "orders", name: "Orders 3" }, "bob");
    expect(renamed.after.config).toEqual(replaced.after.config);
    expect(renamed.after.groupIds).toEqual(["payments"]);
    await expect(store.updateManagedConnection({ id: "missing" }, "bob")).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.updateManagedConnection({ id: "orders", groupIds: ["nope"] }, "bob")).rejects.toThrow(
      "does not exist",
    );
  });

  test("a stored secret that no longer opens is dropped on the next save, never re-sealed", async () => {
    await store.createManagedConnection(
      { id: "o", kind: "database", type: "postgres", name: "O", config: { password: "x" } },
      "a",
    );
    const [record] = await handle.store.listRecords<Record<string, unknown>>("access-connection");
    process.env.STORAGE_ENCRYPTION_KEY = "a-completely-different-key-of-at-least-32-chars";
    resetStorageEncryptionKey();
    try {
      await handle.store.putRecord("access-connection", "o", record, "a");
      const { after } = await store.updateManagedConnection({ id: "o", config: { host: "h" } }, "a");
      expect(after.config).not.toHaveProperty("password");
    } finally {
      delete process.env.STORAGE_ENCRYPTION_KEY;
      resetStorageEncryptionKey();
    }
  });

  test("preview merges a submission with the stored secrets without saving", async () => {
    const sealed = encryptSecret("stored");
    const merged = store.previewManagedConfig("database", { password: sealed, host: "old" }, { host: "new" });
    expect(merged).toEqual({ host: "new", password: sealed });
    expect(store.previewManagedConfig("resource", {}, { endpoint: "https://e", token: "t" })).toEqual({
      endpoint: "https://e",
      token: "t",
    });
  });

  test("delete answers the record and a missing one is 404", async () => {
    await store.createManagedConnection({ id: "o", kind: "resource", type: "kafka", name: "Events" }, "a");
    expect((await store.deleteManagedConnection("o")).name).toBe("Events");
    await expect(store.deleteManagedConnection("o")).rejects.toMatchObject({ statusCode: 404 });
  });
});
