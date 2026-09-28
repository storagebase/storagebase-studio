import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqlForkStore } from "@/lib/fork-store/sql-store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/lib/fork-store/sqlite-driver";
import { getServerAuditBuffer } from "@/lib/audit";
import { encryptSecret, readSecret } from "@/lib/storage/encryption";
import { withServerHeldSecrets } from "@/lib/user-connections/provider";
import { loadSecretRecords, openSecrets, secretRecordKind } from "@/lib/user-connections/store";
import type { ServerStorageProvider, StorageData } from "@/lib/storage/types";
import { memoryStorageProvider, type MemoryStorageProvider } from "../../../helpers/memory-storage-provider";

/**
 * The storage wrapper that keeps credentials out of the synced connection collections: a write
 * moves secrets out, a read never returns one (and migrates a row that still holds one), and every
 * row is answered with the paths the server holds for it.
 */

let store: SqlForkStore;
let inner: MemoryStorageProvider;
let provider: ServerStorageProvider;
let storeMode: "store" | "none";

beforeEach(async () => {
  store = new SqlForkStore(sqliteDriver(new Database(":memory:") as unknown as SqliteDatabaseLike), {
    retentionDays: 0,
  });
  await store.migrate();
  inner = memoryStorageProvider();
  storeMode = "store";
  provider = withServerHeldSecrets(inner, async () => (storeMode === "store" ? store : null));
  getServerAuditBuffer().clear();
});

const PG = { id: "c1", name: "orders", type: "postgres", host: "db", port: 5432, user: "app", password: "pw-1" };
const S3 = { id: "r1", name: "bucket", type: "s3", accessKeyId: "AKIA", secretAccessKey: "SAK-1" };

function stored(collection: string, user = "alice"): Record<string, unknown>[] {
  return inner.rows.get(`${user}\u0000${collection}`) as Record<string, unknown>[];
}

describe("writes", () => {
  test("a pushed secret is moved into the store, sealed, and the stored row carries none", async () => {
    await provider.setCollection("alice", "connections", [PG] as unknown as StorageData["connections"]);
    expect(stored("connections")[0]).not.toHaveProperty("password");
    expect(JSON.stringify([...inner.rows.values()])).not.toContain("pw-1");
    const records = await loadSecretRecords(store, "alice", "database");
    const record = records.get("c1");
    expect(record?.secrets.password).not.toBe("pw-1");
    expect(readSecret(record?.secrets.password as string)).toEqual({ kind: "decrypted", value: "pw-1" });
    expect(openSecrets(record?.secrets ?? {}).secrets).toEqual({ password: "pw-1" });
  });

  test("a later push without the secret keeps it; one for the same target merges; a new target replaces", async () => {
    await provider.setCollection("alice", "connections", [PG] as never);
    await provider.setCollection("alice", "connections", [{ ...PG, password: "" }] as never);
    expect(openSecrets((await loadSecretRecords(store, "alice", "database")).get("c1")!.secrets).secrets).toEqual({
      password: "pw-1",
    });
    await provider.setCollection("alice", "connections", [{ ...PG, password: undefined, agentPassword: "a" }] as never);
    expect(openSecrets((await loadSecretRecords(store, "alice", "database")).get("c1")!.secrets).secrets).toEqual({
      password: "pw-1",
      agentPassword: "a",
    });
    await provider.setCollection("alice", "connections", [{ ...PG, host: "elsewhere", password: "pw-2" }] as never);
    expect(openSecrets((await loadSecretRecords(store, "alice", "database")).get("c1")!.secrets).secrets).toEqual({
      password: "pw-2",
    });
  });

  test("an already-sealed value is not sealed twice; a row with no id and a non-row pass through stripped", async () => {
    const sealed = encryptSecret("pw-9");
    await provider.setCollection("alice", "connections", [
      { ...PG, password: sealed },
      { type: "x", password: "p" },
      7,
    ] as never);
    expect((await loadSecretRecords(store, "alice", "database")).get("c1")!.secrets.password).toBe(sealed);
    expect(stored("connections")[1]).toEqual({ type: "x" });
    expect(stored("connections")[2] as unknown as number).toBe(7);
  });

  test("other collections and non-array values pass straight through", async () => {
    await provider.setCollection("alice", "history", [{ id: "h", password: "not-a-connection" }] as never);
    expect(stored("history")[0]).toHaveProperty("password");
    await provider.setCollection("alice", "connections", "garbage" as never);
    expect(inner.rows.get("alice\u0000connections")).toBe("garbage");
  });

  test("mergeData moves secrets of both families and audits the count", async () => {
    await provider.mergeData("alice", { connections: [PG], resource_connections: [S3], history: [] } as never);
    expect(stored("connections")[0]).not.toHaveProperty("password");
    expect(stored("resource_connections")[0]).not.toHaveProperty("secretAccessKey");
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "connection_secrets_migrated");
    expect(events.map((event) => [event.target, event.details])).toEqual([
      ["database", "1 connection(s)"],
      ["resource", "1 connection(s)"],
    ]);
  });

  test("no secret store: the write fails rather than keeping a secret in the synced row", async () => {
    storeMode = "none";
    await expect(provider.setCollection("alice", "connections", [PG] as never)).rejects.toThrow(
      "secret store is not available",
    );
    await expect(provider.mergeData("alice", { connections: [PG] } as never)).rejects.toThrow();
    expect(inner.rows.size).toBe(0);
  });
});

describe("reads", () => {
  test("a row still holding a secret is migrated on read, once, and audited as a count", async () => {
    await inner.setCollection("alice", "connections", [PG] as never);
    const read = (await provider.getCollection("alice", "connections")) as unknown as Record<string, unknown>[];
    expect(read[0]).not.toHaveProperty("password");
    expect(read[0].savedSecrets).toEqual(["password"]);
    expect(stored("connections")[0]).not.toHaveProperty("password");
    await provider.getCollection("alice", "connections");
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "connection_secrets_migrated");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("pw-1");
  });

  test("getAllData answers both families without secrets and leaves the rest alone", async () => {
    await inner.mergeData("alice", { connections: [PG], resource_connections: [S3], history: [{ id: "h" }] } as never);
    const data = (await provider.getAllData("alice")) as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain("pw-1");
    expect(JSON.stringify(data)).not.toContain("SAK-1");
    expect((data.resource_connections as Record<string, unknown>[])[0].savedSecrets).toEqual(["secretAccessKey"]);
    expect(data.history).toEqual([{ id: "h" }]);
  });

  test("a row whose target changed is served as holding nothing; a row with no record holds []", async () => {
    await provider.setCollection("alice", "connections", [PG, { id: "c2", type: "sqlite", database: "f" }] as never);
    await inner.setCollection("alice", "connections", [
      { ...PG, password: undefined, host: "evil" },
      { id: "c2" },
      3,
    ] as never);
    const read = (await provider.getCollection("alice", "connections")) as unknown as unknown[];
    expect((read[0] as Record<string, unknown>).savedSecrets).toEqual([]);
    expect((read[1] as Record<string, unknown>).savedSecrets).toEqual([]);
    expect(read[2]).toBe(3);
  });

  test("records are per user: bob reads alice's id as holding nothing", async () => {
    await provider.setCollection("alice", "connections", [PG] as never);
    await inner.setCollection("bob", "connections", [{ ...PG, password: undefined }] as never);
    const read = (await provider.getCollection("bob", "connections")) as unknown as Record<string, unknown>[];
    expect(read[0].savedSecrets).toEqual([]);
    expect(secretRecordKind("alice", "database")).not.toBe(secretRecordKind("bob", "database"));
  });

  test("other collections, nulls and the lifecycle pass straight through", async () => {
    expect(await provider.getCollection("alice", "connections")).toBeNull();
    await inner.setCollection("alice", "history", [{ id: "h" }] as never);
    expect(await provider.getCollection("alice", "history")).toEqual([{ id: "h" }] as never);
    await provider.initialize();
    expect(await provider.isHealthy()).toBe(true);
    await provider.close();
  });

  test("the default store opener reaches the fork store (none with local storage)", async () => {
    const previous = process.env.STORAGE_PROVIDER;
    delete process.env.STORAGE_PROVIDER;
    try {
      const wrapped = withServerHeldSecrets(memoryStorageProvider());
      await expect(wrapped.setCollection("alice", "connections", [] as never)).rejects.toThrow("not available");
    } finally {
      if (previous !== undefined) process.env.STORAGE_PROVIDER = previous;
    }
  });
});
