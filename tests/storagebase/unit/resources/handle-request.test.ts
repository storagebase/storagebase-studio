import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realAuth from "@/lib/auth";
import type { SessionReading, UserPayload } from "@/lib/auth";
import { NextResponse } from "next/server";
import * as realVaultClient from "@/lib/seed/vault-client";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import type { ForkStore } from "@/storagebase/store";
import type { StoredResourceConnection } from "@/storagebase/resources/connections";
import {
  forkResourceErrorResponse,
  handleResourceRequest,
  isResourceConnection,
} from "@/storagebase/resources/handle-request";
import { ResourceConfigError } from "@/storagebase/resources/errors";
import type { ResourceConnection } from "@/storagebase/resources/types";
import { createMockRequest } from "../../../helpers/mock-next";

/**
 * The fork resource request pipeline: guard → parse → resolve → run, with the
 * resolve arms pinned one by one. The store is a fake, the seed file a temp
 * YAML, the session a mocked readSession — everything else is the code that
 * runs in production.
 *
 * The pinned 401 shape is the one the route census asserts for every route
 * under src/app/api: proving it here too means a regression is caught by the
 * fork's own tests before the census run.
 */

process.env.STORAGE_ENCRYPTION_KEY = "storagebase-test-encryption-key-0123456789";
delete process.env.JWT_SECRET;
resetStorageEncryptionKey();

const mockGetSession = mock(async (): Promise<UserPayload | null> => ({ role: "user", username: "alice" }));
const mockReadSession = mock(async (): Promise<SessionReading> => {
  const session = await mockGetSession();
  return session ? { kind: "authenticated", session } : { kind: "anonymous" };
});

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mockReadSession,
}));

mock.module("@/lib/seed/vault-client", () => ({
  ...realVaultClient,
  readVaultSecret: mock(async () => "vault-secret-value"),
}));

let storeAvailable = true;
let records: StoredResourceConnection[] = [];

const fakeStore = {
  listRecords: mock(async <T>(): Promise<T[]> => records.slice() as T[]),
  putRecord: mock(async (): Promise<void> => undefined),
  deleteRecord: mock(async (): Promise<void> => undefined),
} as unknown as ForkStore;

mock.module("@/storagebase/store", () => ({
  getForkStore: async () => (storeAvailable ? fakeStore : null),
}));

let seedDir: string;

const STORED: StoredResourceConnection = {
  id: "res_stored1",
  name: "Stored Vault",
  type: "hashicorp-vault",
  createdAt: "2026-11-18T00:00:00.000Z",
  permission: "write",
  endpoint: "https://vault:8200",
  token: "v1:sealed", // replaced with a real envelope in beforeEach
  updatedAt: "2026-11-18T00:00:00.000Z",
  updatedBy: "admin",
};

/** The sealed token the fake store holds; opened under the test key. */
let storedTokenEnvelope: string;

beforeEach(() => {
  clearRateLimitState();
  mockGetSession.mockClear();
  mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
  storeAvailable = true;
  records = [];
  resetStorageEncryptionKey();
  storedTokenEnvelope = "";
  seedDir = mkdtempSync(join(tmpdir(), "sb-handle-request-"));
  process.env.STORAGEBASE_RESOURCE_SEED_PATH = join(seedDir, "resources.yaml");
  writeFileSync(process.env.STORAGEBASE_RESOURCE_SEED_PATH, "connections: []\n", "utf-8");
});

afterEach(() => {
  rmSync(seedDir, { recursive: true, force: true });
  delete process.env.STORAGEBASE_RESOURCE_SEED_PATH;
});

async function seedStored(permission: "read" | "write" | "admin" = "write"): Promise<void> {
  const { sealResourceConnection } = await import("@/storagebase/resources/sealing");
  const sealed = sealResourceConnection({
    id: "res_stored1",
    name: "Stored Vault",
    type: "hashicorp-vault",
    createdAt: "2026-11-18T00:00:00.000Z",
    permission,
    endpoint: "https://vault:8200",
    token: "hvs.stored-token",
  });
  storedTokenEnvelope = sealed.token as string;
  records = [{ ...(sealed as StoredResourceConnection), updatedAt: "2026-11-18T00:00:00.000Z", updatedBy: "admin" }];
}

function writeSeed(text: string): void {
  writeFileSync(process.env.STORAGEBASE_RESOURCE_SEED_PATH as string, text, "utf-8");
}

/** Runs a body through the pipeline against the given route name. */
async function post(route: string, body: unknown): Promise<Response> {
  const url = `/${route}`;
  const request = createMockRequest(url, { method: "POST", body });
  const answer = await handleResourceRequest(request as never, route, async (connection, _body, context) => {
    return NextResponse.json({ connection, context: { session: context.session.username, route: context.route } });
  });
  return answer as unknown as Response;
}

describe("isResourceConnection", () => {
  test("accepts a well-formed resource connection and refuses everything else", () => {
    expect(isResourceConnection({ id: "a", type: "kafka" })).toBe(true);
    expect(isResourceConnection({ id: "a", type: "azure-blob" })).toBe(true);
    expect(isResourceConnection(undefined)).toBe(false);
    expect(isResourceConnection(null)).toBe(false);
    expect(isResourceConnection("kafka")).toBe(false);
    expect(isResourceConnection({ id: "a" })).toBe(false);
    expect(isResourceConnection({ id: "a", type: "postgres" })).toBe(false);
  });
});

describe("handleResourceRequest", () => {
  test("answers the census 401 shape before any body is parsed", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const response = await post("api/sb/resources/tree", { connection: { id: "a", type: "kafka" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
  });

  test("a body that is not JSON, or an empty one, is refused in words", async () => {
    const request = createMockRequest("/api/sb/resources/tree", { method: "POST" });
    const unparseable = await handleResourceRequest(request as never, "api/sb/resources/tree", async () => {
      throw new Error("run must not be reached");
    });
    expect(unparseable.status).toBe(400);
    const empty = await post("api/sb/resources/tree", {});
    expect(empty.status).toBe(400);
    const data = (await empty.json()) as { error: string; code: string };
    expect(data.code).toBe("SB_RESOURCE_INVALID_REQUEST");
  });

  test("a stored connection id resolves with its sealed fields opened server-side", async () => {
    await seedStored();
    const response = await post("api/sb/resources/tree", { connectionId: "res_stored1" });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { connection: ResourceConnection };
    expect(data.connection).toMatchObject({ id: "res_stored1", name: "Stored Vault", token: "hvs.stored-token" });
    expect(data.connection.token).not.toBe(storedTokenEnvelope);
  });

  test("an unknown stored id answers the uniform 404, and a malformed id a 400", async () => {
    await seedStored();
    const unknown = await post("api/sb/resources/tree", { connectionId: "res_missing" });
    expect(unknown.status).toBe(404);
    const data = (await unknown.json()) as { code: string };
    expect(data.code).toBe("SB_RESOURCE_NOT_FOUND");

    for (const connectionId of [42, "", null]) {
      const malformed = await post("api/sb/resources/tree", { connectionId });
      expect(malformed.status).toBe(400);
    }
  });

  test("without a store a stored id answers 503 SB_STORE_UNAVAILABLE", async () => {
    storeAvailable = false;
    const response = await post("api/sb/resources/tree", { connectionId: "res_stored1" });
    expect(response.status).toBe(503);
    const data = (await response.json()) as { code: string };
    expect(data.code).toBe("SB_STORE_UNAVAILABLE");
  });

  test("a stored connection below the route's level answers 403 and never runs the callback", async () => {
    await seedStored("read");
    let ran = false;
    const response = await post("api/sb/vault/secret/save", { connectionId: "res_stored1", name: "x", value: "y" });
    expect(response.status).toBe(403);
    const data = (await response.json()) as { code: string; error: string };
    expect(data.code).toBe("SB_RESOURCE_ACCESS_DENIED");
    expect(data.error).toContain("read");
    expect(data.error).toContain("write");
    expect(ran).toBe(false);
  });

  test("a stored connection's grant allows the route at or below it", async () => {
    await seedStored("write");
    const response = await post("api/sb/resources/tree", { connectionId: "res_stored1" });
    expect(response.status).toBe(200);
  });

  test("a stored admin grant is required for the admin route, and the write grant is not enough", async () => {
    await seedStored("write");
    const response = await post("api/sb/vault/deleted/purge", { connectionId: "res_stored1", name: "x", confirm: "x" });
    expect(response.status).toBe(403);
  });

  test("a seeded id resolves with the roles checked, the vault references read, and the seeded marker", async () => {
    writeSeed(`connections:
  - id: prod-vault
    type: hashicorp-vault
    name: "Prod Vault"
    roles: ["*"]
    permission: write
    fields:
      endpoint: "\${vault:secret/data/studio#endpoint}"
      token: "\${vault:secret/data/studio#token}"
`);
    const response = await post("api/sb/resources/tree", { connectionId: "seed:prod-vault" });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { connection: Record<string, unknown> };
    expect(data.connection).toMatchObject({
      id: "seed:prod-vault",
      name: "Prod Vault",
      type: "hashicorp-vault",
      token: "vault-secret-value",
      endpoint: "vault-secret-value",
      seeded: true,
      permission: "write",
    });
  });

  test("a seeded id the session's roles do not select answers the same 404 an unknown id does", async () => {
    writeSeed(`connections:
  - id: admins-only
    type: hashicorp-vault
    name: "Admins Only"
    roles: ["admin"]
`);
    const notGranted = await post("api/sb/resources/tree", { connectionId: "seed:admins-only" });
    const unknown = await post("api/sb/resources/tree", { connectionId: "seed:no-such-id" });
    expect(notGranted.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await notGranted.json()).toEqual(await unknown.json());
  });

  test("a seeded connection below the route's level answers 403 SB_RESOURCE_ACCESS_DENIED", async () => {
    writeSeed(`connections:
  - id: read-only
    type: hashicorp-vault
    name: "Read Only"
    roles: ["*"]
    fields:
      endpoint: "https://vault:8200"
`);
    const response = await post("api/sb/vault/secret/save", { connectionId: "seed:read-only", name: "x", value: "y" });
    expect(response.status).toBe(403);
    const data = (await response.json()) as { code: string; error: string };
    expect(data.code).toBe("SB_RESOURCE_ACCESS_DENIED");
    expect(data.error).toContain('"Read Only"');
    expect(data.error).toContain("read");
    expect(data.error).toContain("write");
  });

  test("an inline connection runs as given, and one claiming the seed namespace is refused", async () => {
    const inline: ResourceConnection = {
      id: "res_candidate",
      name: "Candidate",
      type: "kafka",
      createdAt: "2026-11-18T00:00:00.000Z",
      endpoint: "broker:9092",
    };
    const response = await post("api/sb/resources/tree", { connection: inline });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { connection: ResourceConnection };
    expect(data.connection).toEqual(inline);

    const claimed = await post("api/sb/resources/tree", { connection: { ...inline, id: "seed:claimed" } });
    expect(claimed.status).toBe(400);
    const body = (await claimed.json()) as { code: string };
    expect(body.code).toBe("SB_RESOURCE_INVALID_REQUEST");
  });

  test("a body naming neither a connection nor an id is refused", async () => {
    const response = await post("api/sb/resources/tree", { parent: "x" });
    expect(response.status).toBe(400);
  });

  test("the connectionId wins when a body carries both an id and an inline copy", async () => {
    await seedStored();
    const response = await post("api/sb/resources/tree", {
      connectionId: "res_stored1",
      connection: { id: "other", type: "kafka", name: "Other", createdAt: "2026-11-18T00:00:00.000Z" },
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { connection: ResourceConnection };
    expect(data.connection.id).toBe("res_stored1");
  });

  test("the run callback receives the session, the route and the connection", async () => {
    const inline: ResourceConnection = { id: "x", type: "kafka", name: "X", createdAt: "2026-11-18T00:00:00.000Z" };
    const response = await post("api/sb/resources/meta", { connection: inline });
    const data = (await response.json()) as { context: { session: string; route: string } };
    expect(data.context).toEqual({ session: "alice", route: "api/sb/resources/meta" });
  });
});

describe("forkResourceErrorResponse", () => {
  test("keeps every fork refusal's code and status", async () => {
    const routeError = forkResourceErrorResponse(
      new (await import("@/storagebase/resources/errors")).ResourceRouteError("no", 400),
    );
    expect(routeError.status).toBe(400);
    expect(await routeError.json()).toMatchObject({ code: "SB_RESOURCE_INVALID_REQUEST", statusCode: 400 });

    const providerRefusal = forkResourceErrorResponse(new ResourceConfigError("bad record"), { route: "x" });
    expect(providerRefusal.status).toBe(400);
    expect(await providerRefusal.json()).toMatchObject({ code: "SB_RESOURCE_CONFIG_ERROR", statusCode: 400 });
  });

  test("delegates what is not the fork's to upstream's mapper — a generic error stays a 500", async () => {
    const response = forkResourceErrorResponse(new Error("unhandled"), { route: "x" });
    expect(response.status).toBe(500);
  });
});
