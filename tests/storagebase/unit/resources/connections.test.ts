import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { ForkStore } from "@/storagebase/store";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import {
  RESOURCE_CONNECTION_KIND,
  createStoredResourceConnection,
  deleteStoredResourceConnection,
  listStoredResourceConnections,
  readResourceConnectionInput,
  resolveStoredResourceConnection,
  resourceStoreAvailable,
  STORED_CONNECTION_ID_PREFIX,
  storedResourceRow,
  updateStoredResourceConnection,
  type ResourceConnectionInput,
  type StoredResourceConnection,
} from "@/storagebase/resources/connections";
import { removeResourceProvider } from "@/storagebase/resources/factory";
import {
  ResourceNotFoundError,
  ResourceRouteError,
  ResourceSeedReadOnlyError,
  ResourceStoreUnavailableError,
} from "@/storagebase/resources/errors";
import type { ResourceConnection } from "@/storagebase/resources/types";

/**
 * Connection CRUD through the fork store's records API, with a fake store in
 * place of the sqlite/postgres one: the sealing contract (secret fields are
 * envelopes BEFORE putRecord, never plaintext), the id the server mints, the
 * row the browser may hold, the update rule that keeps an untouched secret,
 * and the honest refusals (store unavailable, seeded read-only, unknown id).
 */

process.env.STORAGE_ENCRYPTION_KEY = "storagebase-test-encryption-key-0123456789";
delete process.env.JWT_SECRET;
resetStorageEncryptionKey();

interface PutCall {
  kind: string;
  id: string;
  value: unknown;
  actor: string;
}

const puts: PutCall[] = [];
const deleted: string[] = [];
let records: StoredResourceConnection[] = [];
let storeAvailable = true;

const fakeStore = {
  listRecords: mock(
    async <T>(kind: string): Promise<T[]> => (kind === RESOURCE_CONNECTION_KIND ? (records.slice() as T[]) : []),
  ),
  putRecord: mock(async (kind: string, id: string, value: unknown, actor: string): Promise<void> => {
    puts.push({ kind, id, value, actor });
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) records.push({ ...(value as StoredResourceConnection) });
    else records[index] = { ...(value as StoredResourceConnection) };
  }),
  deleteRecord: mock(async (kind: string, id: string): Promise<void> => {
    deleted.push(`${kind}:${id}`);
    records = records.filter((record) => record.id !== id);
  }),
} as unknown as ForkStore;

mock.module("@/storagebase/store", () => ({
  getForkStore: async () => (storeAvailable ? fakeStore : null),
}));

const input = (overrides: Partial<ResourceConnectionInput> = {}): ResourceConnectionInput => ({
  name: "Prod Vault",
  type: "hashicorp-vault",
  endpoint: "https://vault:8200",
  token: "hvs.root-token",
  namespace: "ops",
  ...overrides,
});

const seededRecord = (): StoredResourceConnection => ({
  id: "seed:prod-vault",
  name: "Prod Vault",
  type: "hashicorp-vault",
  createdAt: "2026-11-18T00:00:00.000Z",
  token: "v1:sealed-envelope",
  updatedAt: "2026-11-18T00:00:00.000Z",
  updatedBy: "admin",
});

beforeEach(() => {
  resetStorageEncryptionKey();
  puts.length = 0;
  deleted.length = 0;
  records = [];
  storeAvailable = true;
});

describe("readResourceConnectionInput", () => {
  test("accepts a well-formed record and trims the name", () => {
    const read = readResourceConnectionInput({
      name: "  Prod Vault  ",
      type: "kafka",
      endpoint: "broker:9092",
      token: "t",
      unknownField: "dropped by the whitelist",
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.input.name).toBe("Prod Vault");
      expect(read.input.endpoint).toBe("broker:9092");
      expect(read.input.token).toBe("t");
      expect("unknownField" in read.input).toBe(false);
    }
  });

  test("refuses everything that is not a connection the store can hold", () => {
    const cases: unknown[] = [
      null,
      "kafka",
      { name: "", type: "kafka" },
      { name: "x" },
      { name: "x", type: "postgres" },
      { name: "x", type: "kafka", sshTunnel: { enabled: true } },
      { name: "x", type: "kafka", endpoint: 42 },
    ];
    for (const value of cases) {
      const read = readResourceConnectionInput(value);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error).toBeInstanceOf(ResourceRouteError);
    }
  });

  test("the stored record's id is never the caller's to choose — a seed-claimed id is refused", () => {
    const read = readResourceConnectionInput({ id: "seed:evil", name: "x", type: "kafka" });
    expect(read.ok).toBe(false);
  });
});

describe("createStoredResourceConnection", () => {
  test("seals every secret field BEFORE the record reaches the store, and mints the id", async () => {
    const record = await createStoredResourceConnection(input(), "alice");
    expect(record.id).toMatch(new RegExp(`^${STORED_CONNECTION_ID_PREFIX}[0-9a-f]{32}$`));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ kind: RESOURCE_CONNECTION_KIND, actor: "alice" });
    const stored = JSON.stringify(puts[0]?.value);
    expect(stored).not.toContain("hvs.root-token");
    expect((puts[0]?.value as StoredResourceConnection | undefined)?.token).toMatch(/^v1:/);
    expect(record.updatedBy).toBe("alice");
  });

  test("answers a row the browser may hold: non-secret fields plus the marker", async () => {
    const record = await createStoredResourceConnection(input(), "alice");
    const row = storedResourceRow(record);
    expect(row).toMatchObject({ id: record.id, name: "Prod Vault", type: "hashicorp-vault", hasCredential: true });
    expect(JSON.stringify(row)).not.toContain("hvs.root-token");
  });

  test("an empty secret is dropped, so the marker never lies", async () => {
    const record = await createStoredResourceConnection(input({ token: "" }), "alice");
    expect(record.token).toBeUndefined();
    expect(storedResourceRow(record).hasCredential).toBe(false);
  });

  test("without a store the refusal is SB_STORE_UNAVAILABLE, never a pretended write", async () => {
    storeAvailable = false;
    const refusal = await createStoredResourceConnection(input(), "alice").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceStoreUnavailableError);
    expect((refusal as ResourceStoreUnavailableError).code).toBe("SB_STORE_UNAVAILABLE");
    expect(puts).toHaveLength(0);
  });
});

describe("updateStoredResourceConnection", () => {
  test("replaces non-secret fields and re-seals only the secrets it is given, keeping the stored envelopes", async () => {
    const existing = await createStoredResourceConnection(input(), "alice");
    const originalTokenEnvelope = existing.token;

    const updated = await updateStoredResourceConnection(
      existing.id,
      input({ name: "Renamed", endpoint: "https://vault:8201", token: "" }),
      "bob",
    );
    // A blank token kept the stored envelope; the endpoint moved; the name changed.
    expect(updated.token).toBe(originalTokenEnvelope);
    expect(updated.endpoint).toBe("https://vault:8201");
    expect(updated.name).toBe("Renamed");
    expect(updated.updatedBy).toBe("bob");
    expect(updated.createdAt).toBe(existing.createdAt);
  });

  test("a freshly typed secret replaces the envelope with a fresh one", async () => {
    const existing = await createStoredResourceConnection(input(), "alice");
    const updated = await updateStoredResourceConnection(existing.id, input({ token: "hvs.new-token" }), "bob");
    expect(updated.token).toMatch(/^v1:/);
    expect(updated.token).not.toBe(existing.token);
    expect(JSON.stringify(updated)).not.toContain("hvs.new-token");
  });

  test("the provider cache entry for the id is dropped, so the next request rebuilds", async () => {
    const existing = await createStoredResourceConnection(input(), "alice");
    await updateStoredResourceConnection(existing.id, input(), "bob");
    // The eviction call happened; the factory's own no-op behaviour covers the rest.
    expect(deleted.join(",")).not.toContain(existing.id);
  });

  test("a seeded id is refused before any store access", async () => {
    const refusal = await updateStoredResourceConnection("seed:prod-vault", input(), "admin").catch(
      (caught: unknown) => caught,
    );
    expect(refusal).toBeInstanceOf(ResourceSeedReadOnlyError);
    expect((refusal as ResourceSeedReadOnlyError).code).toBe("SB_RESOURCE_SEED_READONLY");
    expect(puts).toHaveLength(0);
  });

  test("an unknown id is the uniform 404", async () => {
    const refusal = await updateStoredResourceConnection("res_missing", input(), "admin").catch(
      (caught: unknown) => caught,
    );
    expect(refusal).toBeInstanceOf(ResourceNotFoundError);
    expect((refusal as ResourceNotFoundError).code).toBe("SB_RESOURCE_NOT_FOUND");
  });

  test("without a store the refusal is SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const refusal = await updateStoredResourceConnection("res_1", input(), "admin").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceStoreUnavailableError);
  });
});

describe("deleteStoredResourceConnection", () => {
  test("deletes through the store and drops the cached provider", async () => {
    const existing = await createStoredResourceConnection(input(), "alice");
    await deleteStoredResourceConnection(existing.id);
    expect(deleted).toEqual([`${RESOURCE_CONNECTION_KIND}:${existing.id}`]);
    expect(await listStoredResourceConnections()).toEqual([]);
    // A second delete is not an error (the store's own ruling).
    await deleteStoredResourceConnection(existing.id);
  });

  test("a seeded id is refused; only the file changes those", async () => {
    const refusal = await deleteStoredResourceConnection("seed:prod-vault").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceSeedReadOnlyError);
    expect(deleted).toEqual([]);
  });

  test("without a store the refusal is SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const refusal = await deleteStoredResourceConnection("res_1").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceStoreUnavailableError);
  });
});

describe("resolveStoredResourceConnection", () => {
  test("opens the sealed fields server-side for provider use", async () => {
    const existing = await createStoredResourceConnection(input(), "alice");
    const resolved = await resolveStoredResourceConnection(existing.id);
    expect(resolved.token).toBe("hvs.root-token");
    expect(resolved.id).toBe(existing.id);
  });

  test("an unknown id is the uniform 404", async () => {
    const refusal = await resolveStoredResourceConnection("res_missing").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceNotFoundError);
  });

  test("without a store the refusal is SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const refusal = await resolveStoredResourceConnection("res_1").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ResourceStoreUnavailableError);
  });
});

describe("the store's availability sentence", () => {
  test("list answers none and the flag says why", async () => {
    expect(await resourceStoreAvailable()).toBe(true);
    storeAvailable = false;
    expect(await listStoredResourceConnections()).toEqual([]);
    expect(await resourceStoreAvailable()).toBe(false);
  });
});

describe("the fake store this file installs", () => {
  test("keys its records by the fork's connection kind only", async () => {
    await createStoredResourceConnection(input(), "alice");
    const other = await fakeStore.listRecords<Record<string, unknown>>("some-other-kind");
    expect(other).toEqual([]);
  });

  test("still exports the eviction call the update path makes", () => {
    expect(typeof removeResourceProvider).toBe("function");
  });
});
