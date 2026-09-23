import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceConnectionError } from "@/lib/resources/errors";

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
}));

const mockReadSecret = mock(async (_path: string) => ({
  name: "storagebase/fixture",
  value: JSON.stringify({ username: "fixture" }),
  metadata: { version: "1", createdAt: null },
}));
const mockWriteSecret = mock(async () => undefined);
const mockDeleteSecret = mock(async () => undefined);

const fakeVault = {
  listMounts: async () => ({ nodes: [], truncated: false }),
  listSecrets: async () => ({ nodes: [], truncated: false }),
  readSecret: mockReadSecret,
  writeSecret: mockWriteSecret,
  deleteSecret: mockDeleteSecret,
  getCapabilities: () => ({
    category: "vault",
    defaultPort: 8200,
    supportsSshTunnel: false,
    operations: ["tree", "secret.read", "secret.write", "secret.delete"],
  }),
  getLabels: () => ({ containerNoun: "Mounts", itemNoun: "Secrets" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockGetOrCreateResourceProvider = mock(async () => fakeVault);

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeVault),
  getOrCreateResourceProvider: mockGetOrCreateResourceProvider,
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { POST: postRead } = await import("@/app/api/resources/secret/read/route");
const { POST: postWrite } = await import("@/app/api/resources/secret/write/route");
const { POST: postDelete } = await import("@/app/api/resources/secret/delete/route");

const connection = {
  id: "res-1",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:8210",
};

function auditEvents() {
  return mockEmitAuditEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe("secret routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeVault);
    mockReadSecret.mockClear();
    mockWriteSecret.mockClear();
    mockDeleteSecret.mockClear();
  });

  test("read answers the value and audits the access", async () => {
    const req = createMockRequest("/api/resources/secret/read", {
      method: "POST",
      body: { connection, path: "storagebase/fixture" },
    });
    const res = await postRead(req as never);
    const data = await parseResponseJSON<{ value: string }>(res);
    expect(res.status).toBe(200);
    expect(JSON.parse(data.value)).toEqual({ username: "fixture" });

    // Reads audit like writes (the deliberate exception): secret material
    // access is what operators filter the trail for.
    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "resource_operation", action: "secret.read", result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("read without a path is a 400", async () => {
    const req = createMockRequest("/api/resources/secret/read", {
      method: "POST",
      body: { connection, path: "" },
    });
    expect((await postRead(req as never)).status).toBe(400);
    expect(mockReadSecret).not.toHaveBeenCalled();
  });

  test("write saves and records decision + outcome", async () => {
    const req = createMockRequest("/api/resources/secret/write", {
      method: "POST",
      body: { connection, path: "storagebase/new", value: JSON.stringify({ a: 1 }) },
    });
    const res = await postWrite(req as never);
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ written: boolean }>(res)).written).toBe(true);
    expect(mockWriteSecret).toHaveBeenCalledWith("storagebase/new", JSON.stringify({ a: 1 }));

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "secret.write", result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("write without a string value is a 400", async () => {
    const req = createMockRequest("/api/resources/secret/write", {
      method: "POST",
      body: { connection, path: "storagebase/new", value: 42 },
    });
    expect((await postWrite(req as never)).status).toBe(400);
    expect(mockWriteSecret).not.toHaveBeenCalled();
  });

  test("delete removes and records decision + outcome", async () => {
    const req = createMockRequest("/api/resources/secret/delete", {
      method: "POST",
      body: { connection, path: "storagebase/old" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ deleted: boolean }>(res)).deleted).toBe(true);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "secret.delete", result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("a provider failure on read is a 502 with resource_failed in the outcome", async () => {
    mockReadSecret.mockRejectedValueOnce(new ResourceConnectionError("vault sealed"));
    const req = createMockRequest("/api/resources/secret/read", {
      method: "POST",
      body: { connection, path: "storagebase/fixture" },
    });
    expect((await postRead(req as never)).status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "secret.read", result: "failure", reason: "resource_failed" });
  });

  test("a provider failure on delete is a 502 with resource_failed in the outcome", async () => {
    mockDeleteSecret.mockRejectedValueOnce(new ResourceConnectionError("vault sealed"));
    const req = createMockRequest("/api/resources/secret/delete", {
      method: "POST",
      body: { connection, path: "storagebase/old" },
    });
    expect((await postDelete(req as never)).status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "secret.delete", result: "failure", reason: "resource_failed" });
  });

  test("routes require a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/secret/delete", {
      method: "POST",
      body: { connection, path: "storagebase/old" },
    });
    expect((await postDelete(req as never)).status).toBe(401);
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeVault,
      getCapabilities: () => ({ ...fakeVault.getCapabilities(), operations: ["tree"] }),
    }));
    const req = createMockRequest("/api/resources/secret/write", {
      method: "POST",
      body: { connection, path: "storagebase/new", value: "x" },
    });
    const res = await postWrite(req as never);
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("RESOURCE_OPERATION_UNSUPPORTED");
  });
});
