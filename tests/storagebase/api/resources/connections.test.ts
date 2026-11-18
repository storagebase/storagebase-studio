import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import type { SessionReading, UserPayload } from "@/lib/auth";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import type { ForkStore } from "@/storagebase/store";
import type { StoredResourceConnection } from "@/storagebase/resources/connections";
import { RESOURCE_CONNECTION_KIND } from "@/storagebase/resources/connections";

/**
 * The connection catalog's route surface, end to end: the list merge (store +
 * role-matched seed rows, never a secret value), admin-only create/update/
 * delete (a stored record is shared, deployment-wide), the seeded
 * read-only refusal, and the honest SB_STORE_UNAVAILABLE when the deployment
 * has no store to persist into.
 */

process.env.STORAGE_ENCRYPTION_KEY = "storagebase-test-encryption-key-0123456789";
delete process.env.JWT_SECRET;
resetStorageEncryptionKey();

const mockGetSession = mock(async (): Promise<UserPayload | null> => ({ role: "admin", username: "admin" }));
const mockReadSession = mock(async (): Promise<SessionReading> => {
  const session = await mockGetSession();
  return session ? { kind: "authenticated", session } : { kind: "anonymous" };
});

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mockReadSession,
}));

const records = new Map<string, StoredResourceConnection>();
const deleted: string[] = [];
let storeAvailable = true;

const fakeStoreMocks = {
  listRecords: mock(async <T>(): Promise<T[]> => [...records.values()].slice() as T[]),
  putRecord: mock(async (_kind: string, id: string, value: StoredResourceConnection): Promise<void> => {
    records.set(id, { ...value });
  }),
  deleteRecord: mock(async (_kind: string, id: string): Promise<void> => {
    deleted.push(id);
    records.delete(id);
  }),
};
const fakeStore = fakeStoreMocks as unknown as ForkStore;

mock.module("@/storagebase/store", () => ({
  getForkStore: async () => (storeAvailable ? fakeStore : null),
}));

let seedDir: string;

function writeSeed(text: string): void {
  const path = process.env.STORAGEBASE_RESOURCE_SEED_PATH as string;
  writeFileSync(path, text, "utf-8");
}

beforeEach(() => {
  clearRateLimitState();
  resetStorageEncryptionKey();
  records.clear();
  deleted.length = 0;
  storeAvailable = true;
  mockGetSession.mockClear();
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  seedDir = mkdtempSync(join(tmpdir(), "sb-connections-api-"));
  process.env.STORAGEBASE_RESOURCE_SEED_PATH = join(seedDir, "resources.yaml");
  writeFileSync(process.env.STORAGEBASE_RESOURCE_SEED_PATH, "connections: []\n", "utf-8");
});

afterEach(() => {
  rmSync(seedDir, { recursive: true, force: true });
  delete process.env.STORAGEBASE_RESOURCE_SEED_PATH;
});

const { POST: connectionsPOST } = await import("@/app/api/sb/resources/connections/route");
const { POST: connectionByIdPOST } = await import("@/app/api/sb/resources/connections/[id]/route");

const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

const createBody = {
  action: "create",
  connection: {
    name: "Prod Vault",
    type: "hashicorp-vault",
    endpoint: "https://vault:8200",
    token: "hvs.root-token",
    namespace: "ops",
  },
};

describe("POST /api/sb/resources/connections (list + create)", () => {
  test("answers 401 with the census shape before anything is parsed", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: { action: "list" } });
    const res = await connectionsPOST(req as never);
    expect(res.status).toBe(401);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });

  test("list merges the store's rows and the role-matched seed rows, sorted by name", async () => {
    writeSeed(`connections:
  - id: seed-vault
    type: hashicorp-vault
    name: "A Seeded Vault"
    roles: ["*"]
    permission: write
    fields:
      endpoint: "https://vault:8200"
      token: "\${vault:secret/data/studio#token}"
  - id: admins-only
    type: kafka
    name: "Admins Only Kafka"
    roles: ["admin"]
`);
    // A stored row exists too, sealed.
    await connectionsPOST(
      createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody }) as never,
    );

    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: { action: "list" } });
    const res = await connectionsPOST(req as never);
    const data = await parseResponseJSON<{
      connections: Array<Record<string, unknown>>;
      storeAvailable: boolean;
    }>(res);
    expect(res.status).toBe(200);
    expect(data.storeAvailable).toBe(true);
    // The stored row (named "Prod Vault"), the wildcard seed ("A Seeded Vault")
    // and the admin-granted seed ("Admins Only Kafka"): this session IS an
    // admin's, so all three list, sorted by name.
    expect(data.connections.map((row) => row.name)).toEqual(["A Seeded Vault", "Admins Only Kafka", "Prod Vault"]);
    const seededRow = data.connections[0];
    expect(seededRow).toMatchObject({ id: "seed:seed-vault", seeded: true, permission: "write", hasCredential: true });
    // Never a secret value in any row, resolved or not.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("hvs.root-token");
    expect(serialized).not.toContain("vault:secret/data/studio#token");
  });

  test("list with no store serves the seed rows alone and says storeAvailable: false", async () => {
    storeAvailable = false;
    writeSeed(`connections:
  - id: only-seed
    type: kafka
    name: "Only Seed"
    roles: ["*"]
`);
    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: { action: "list" } });
    const res = await connectionsPOST(req as never);
    const data = await parseResponseJSON<{ connections: unknown[]; storeAvailable: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.storeAvailable).toBe(false);
    expect(data.connections).toHaveLength(1);
  });

  test("a user cannot create: the role denial answers 403 with the admin body", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody });
    const res = await connectionsPOST(req as never);
    expect(res.status).toBe(403);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Unauthorized. Admin access required.",
      code: "ADMIN_REQUIRED",
    });
    expect(records.size).toBe(0);
  });

  test("an admin creates: the record is sealed before the store sees it, and the row never echoes the secret", async () => {
    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody });
    const res = await connectionsPOST(req as never);
    expect(res.status).toBe(200);
    const data = await parseResponseJSON<{ connection: Record<string, unknown> }>(res);
    const row = data.connection;
    expect(row.id).toMatch(/^res_[0-9a-f]{32}$/);
    expect(row).toMatchObject({ name: "Prod Vault", type: "hashicorp-vault", hasCredential: true });
    expect(JSON.stringify(row)).not.toContain("hvs.root-token");

    const stored = records.get(row.id as string) as StoredResourceConnection;
    expect(stored.token).toMatch(/^v1:/);
    expect(stored.updatedBy).toBe("admin");
    expect(JSON.stringify(stored)).not.toContain("hvs.root-token");
  });

  test("create refuses an invalid body with the fork's invalid-request code", async () => {
    for (const body of [
      { action: "create", connection: null },
      { action: "create", connection: { type: "kafka" } },
      { action: "create", connection: { name: "x", type: "postgres" } },
      { action: "create", connection: { name: "x", type: "kafka", sshTunnel: { enabled: true } } },
      { action: "unknown" },
      {},
    ]) {
      const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body });
      const res = await connectionsPOST(req as never);
      expect(res.status).toBe(400);
      const data = await parseResponseJSON<{ code: string }>(res);
      expect(data.code).toBe("SB_RESOURCE_INVALID_REQUEST");
    }
  });

  test("create without a store answers 503 SB_STORE_UNAVAILABLE rather than pretending", async () => {
    storeAvailable = false;
    const req = createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody });
    const res = await connectionsPOST(req as never);
    expect(res.status).toBe(503);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("SB_STORE_UNAVAILABLE");
  });

  test("a body that is not JSON reads as no action, and the refusal says so", async () => {
    const req = new Request("http://localhost:3000/api/sb/resources/connections", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await connectionsPOST(req as never);
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("SB_RESOURCE_INVALID_REQUEST");
  });
});

describe("POST /api/sb/resources/connections/[id] (update + delete)", () => {
  test("answers 401 with the census shape before the role check", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/connections/res_1", {
      method: "POST",
      body: { action: "delete" },
    });
    const res = await connectionByIdPOST(req as never, paramsFor("res_1"));
    expect(res.status).toBe(401);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });

  test("a user is refused before any body is read", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
    const req = createMockRequest("/api/sb/resources/connections/res_1", {
      method: "POST",
      body: { action: "delete" },
    });
    const res = await connectionByIdPOST(req as never, paramsFor("res_1"));
    expect(res.status).toBe(403);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Unauthorized. Admin access required.",
      code: "ADMIN_REQUIRED",
    });
  });

  test("an admin updates: blank secrets keep their envelope, fresh ones re-seal, the row never echoes", async () => {
    const created = await connectionsPOST(
      createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody }) as never,
    );
    const createdRow = (await parseResponseJSON<{ connection: { id: string } }>(created)).connection;
    const stored = records.get(createdRow.id) as StoredResourceConnection;

    const req = createMockRequest(`/api/sb/resources/connections/${createdRow.id}`, {
      method: "POST",
      body: {
        action: "update",
        connection: { name: "Renamed", type: "hashicorp-vault", endpoint: "https://vault:8201", token: "" },
      },
    });
    const res = await connectionByIdPOST(req as never, paramsFor(createdRow.id));
    expect(res.status).toBe(200);
    const data = await parseResponseJSON<{ connection: Record<string, unknown> }>(res);
    expect(data.connection).toMatchObject({ name: "Renamed", endpoint: "https://vault:8201", hasCredential: true });
    expect(JSON.stringify(data.connection)).not.toContain("hvs.root-token");

    const updated = records.get(createdRow.id) as StoredResourceConnection;
    // A blank token kept the stored envelope exactly — no double sealing.
    expect(updated.token).toBe(stored.token);
    expect(updated.updatedBy).toBe("admin");
  });

  test("update refuses a seeded id before any store access", async () => {
    const req = createMockRequest("/api/sb/resources/connections/seed:prod", {
      method: "POST",
      body: { action: "update", connection: { name: "x", type: "kafka" } },
    });
    const res = await connectionByIdPOST(req as never, paramsFor("seed:prod"));
    expect(res.status).toBe(403);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("SB_RESOURCE_SEED_READONLY");
  });

  test("update answers the uniform 404 for an unknown id, and 400 for a bad body", async () => {
    const missing = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/res_missing", {
        method: "POST",
        body: { action: "update", connection: { name: "x", type: "kafka" } },
      }) as never,
      paramsFor("res_missing"),
    );
    expect(missing.status).toBe(404);

    const badBody = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/res_missing", {
        method: "POST",
        body: { action: "update", connection: null },
      }) as never,
      paramsFor("res_missing"),
    );
    expect(badBody.status).toBe(400);

    const unknownAction = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/res_x", { method: "POST", body: { action: "nope" } }) as never,
      paramsFor("res_x"),
    );
    expect(unknownAction.status).toBe(400);
  });

  test("update without a store answers 503 SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const res = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/res_1", {
        method: "POST",
        body: { action: "update", connection: { name: "x", type: "kafka" } },
      }) as never,
      paramsFor("res_1"),
    );
    expect(res.status).toBe(503);
  });

  test("an admin deletes a stored connection, and a missing id is not an error", async () => {
    const created = await connectionsPOST(
      createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody }) as never,
    );
    const createdRow = (await parseResponseJSON<{ connection: { id: string } }>(created)).connection;

    const res = await connectionByIdPOST(
      createMockRequest(`/api/sb/resources/connections/${createdRow.id}`, {
        method: "POST",
        body: { action: "delete" },
      }) as never,
      paramsFor(createdRow.id),
    );
    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ deleted: boolean }>(res)).toEqual({ deleted: true });
    expect(deleted).toEqual([createdRow.id]);
    expect(records.size).toBe(0);

    // The idempotent second delete.
    const again = await connectionByIdPOST(
      createMockRequest(`/api/sb/resources/connections/${createdRow.id}`, {
        method: "POST",
        body: { action: "delete" },
      }) as never,
      paramsFor(createdRow.id),
    );
    expect(again.status).toBe(200);
  });

  test("delete refuses a seeded id: only the file changes those", async () => {
    const res = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/seed:prod", {
        method: "POST",
        body: { action: "delete" },
      }) as never,
      paramsFor("seed:prod"),
    );
    expect(res.status).toBe(403);
    expect(await parseResponseJSON<{ code: string }>(res)).toMatchObject({ code: "SB_RESOURCE_SEED_READONLY" });
    expect(deleted).toEqual([]);
  });

  test("delete without a store answers 503 SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const res = await connectionByIdPOST(
      createMockRequest("/api/sb/resources/connections/res_1", { method: "POST", body: { action: "delete" } }) as never,
      paramsFor("res_1"),
    );
    expect(res.status).toBe(503);
    expect(await parseResponseJSON<{ code: string }>(res)).toMatchObject({ code: "SB_STORE_UNAVAILABLE" });
  });

  test("a body that is not JSON reads as no action, and the refusal says so", async () => {
    const req = new Request("http://localhost:3000/api/sb/resources/connections/res_1", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await connectionByIdPOST(req as never, paramsFor("res_1"));
    expect(res.status).toBe(400);
    expect(await parseResponseJSON<{ code: string }>(res)).toMatchObject({ code: "SB_RESOURCE_INVALID_REQUEST" });
  });

  test("the store is keyed by the fork's connection kind", async () => {
    const created = await connectionsPOST(
      createMockRequest("/api/sb/resources/connections", { method: "POST", body: createBody }) as never,
    );
    const createdRow = (await parseResponseJSON<{ connection: { id: string } }>(created)).connection;
    expect(records.has(createdRow.id)).toBe(true);
    expect(fakeStoreMocks.putRecord.mock.calls.some((call) => call[0] === RESOURCE_CONNECTION_KIND)).toBe(true);
  });
});
