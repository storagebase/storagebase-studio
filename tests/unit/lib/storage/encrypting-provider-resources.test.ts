import { describe, test, expect } from "bun:test";
import { withCredentialEncryption } from "@/lib/storage/encrypting-provider";
import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";
import type { ResourceConnection } from "@/lib/resources/types";

/** A recorder standing in for sqlite/postgres: it stores whatever it is handed. */
function fakeInner() {
  const store: Partial<StorageData> = {};
  const provider: ServerStorageProvider = {
    initialize: async () => undefined,
    getAllData: async () => ({ ...store }),
    getCollection: async (_userId, collection) => store[collection] ?? null,
    setCollection: async (_userId, collection, data) => {
      store[collection] = data as never;
    },
    mergeData: async (_userId, data) => {
      Object.assign(store, data);
    },
    isHealthy: async () => true,
    close: async () => undefined,
  };
  return { store, provider };
}

const connection = (token: string): ResourceConnection => ({
  id: "res-1",
  name: "Test",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://vault:8200",
  token,
});

describe("credential encryption over resource_connections", () => {
  test("a set seals the token and a get opens it — ciphertext never rests readable", async () => {
    const { store, provider } = fakeInner();
    const wrapped = withCredentialEncryption(provider);
    await wrapped.setCollection("u", "resource_connections", [connection("tok")]);
    expect(store.resource_connections?.[0].token).not.toBe("tok");
    const opened = await wrapped.getCollection("u", "resource_connections");
    expect(opened?.[0].token).toBe("tok");
    expect(opened?.[0].endpoint).toBe("https://vault:8200");
  });

  test("getAllData opens resource credentials alongside the database ones", async () => {
    const { store, provider } = fakeInner();
    store.resource_connections = [connection("tok")];
    const wrapped = withCredentialEncryption(provider);
    const data = await wrapped.getAllData("u");
    expect(data.resource_connections?.[0].token).toBe("tok");
  });

  test("mergeData seals resource credentials before they merge", async () => {
    const { store, provider } = fakeInner();
    const wrapped = withCredentialEncryption(provider);
    await wrapped.mergeData("u", { resource_connections: [connection("tok")] });
    expect(store.resource_connections?.[0].token).not.toBe("tok");
  });

  test("non-credential collections pass through untouched either way", async () => {
    const { provider } = fakeInner();
    const wrapped = withCredentialEncryption(provider);
    await wrapped.setCollection("u", "history", []);
    expect(await wrapped.getCollection("u", "history")).toEqual([]);
  });
});
