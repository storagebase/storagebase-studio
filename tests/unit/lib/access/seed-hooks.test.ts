import { beforeEach, describe, expect, mock, test } from "bun:test";
import { memoryStorageProvider, type MemoryStorageProvider } from "../../../helpers/memory-storage-provider";
import { installAccessStore } from "../../../helpers/access-store";

/**
 * `user:<id>` resolution for the database routes (StorageBase fork): a non-user
 * id is not ours (null, the upstream path carries on), an unknown user id is a
 * 404 like any missing connection, and a known one resolves with its secrets.
 */

const handle = installAccessStore();
let inner: MemoryStorageProvider;

mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => inner,
  getStorageProviderType: () => "sqlite",
}));

const server = await import("@/lib/user-connections/server");
const { resolveOwnedConnection } = await import("@/lib/access/seed-hooks");

const session = { role: "user", username: "alice" };
const PG = { id: "c1", name: "orders", type: "postgres", host: "db", port: 5432, user: "app", password: "pw-1" };

beforeEach(async () => {
  await handle.reset();
  inner = memoryStorageProvider();
});

async function saveOwn(): Promise<void> {
  await server.saveUserConnection("alice", "database", PG);
}

describe("resolveOwnedConnection", () => {
  test("a non-user id is not ours", async () => {
    expect(await resolveOwnedConnection("seed:m_orders", session)).toBeNull();
    expect(await resolveOwnedConnection("plain-id", session)).toBeNull();
  });

  test("an unknown user id is a 404, including another user's", async () => {
    await saveOwn();
    await expect(resolveOwnedConnection("user:missing", session)).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveOwnedConnection("user:c1", { role: "user", username: "bob" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test("a known id resolves with its held secrets", async () => {
    await saveOwn();
    const resolved = await resolveOwnedConnection("user:c1", session);
    expect(resolved).toMatchObject({ id: "c1", password: "pw-1" });
  });
});
