import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";

const mockGetOrCreate = mock(async () => fakeProvider);
const mockRemove = mock(async () => undefined);

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

const fakeProvider = {
  getHealth: async () => ({ status: "healthy" as const, message: "ok", latencyMs: 7 }),
  listNodes: async () => ({ nodes: [], truncated: false }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeProvider),
  getOrCreateResourceProvider: mockGetOrCreate,
  removeResourceProvider: mockRemove,
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { POST: healthPOST } = await import("@/app/api/resources/health/route");
const { POST: treePOST } = await import("@/app/api/resources/tree/route");

const connection = {
  id: "res-1",
  name: "Test",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("POST /api/resources/health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreate.mockClear();
    mockGetOrCreate.mockImplementation(async () => fakeProvider);
    mockRemove.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the provider's health answer", async () => {
    const req = createMockRequest("/api/resources/health", { method: "POST", body: { connection } });
    const res = await healthPOST(req as never);
    const data = await parseResponseJSON<{ status: string; latencyMs: number }>(res);
    expect(res.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.latencyMs).toBe(7);
  });

  test("a dead provider is evicted, then the refusal reaches the caller", async () => {
    mockGetOrCreate.mockRejectedValueOnce(new Error("socket gone"));
    const req = createMockRequest("/api/resources/health", { method: "POST", body: { connection } });
    const res = await healthPOST(req as never);
    expect(mockRemove).toHaveBeenCalledWith("res-1");
    expect(res.status).toBe(500);
  });
});

describe("POST /api/resources/tree", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreate.mockClear();
    mockGetOrCreate.mockImplementation(async () => fakeProvider);
    mockRemove.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the node page for the root level when no parent is named", async () => {
    const req = createMockRequest("/api/resources/tree", { method: "POST", body: { connection } });
    const res = await treePOST(req as never);
    const data = await parseResponseJSON<{ nodes: unknown[]; truncated: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.nodes).toEqual([]);
    expect(data.truncated).toBe(false);
  });

  test("refuses a non-string and an empty parent without reaching the provider", async () => {
    for (const parent of ["", 42, ["a"]]) {
      const req = createMockRequest("/api/resources/tree", { method: "POST", body: { connection, parent } });
      const res = await treePOST(req as never);
      expect(res.status).toBe(400);
    }
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  test("a dead provider is evicted, then the refusal reaches the caller", async () => {
    mockGetOrCreate.mockRejectedValueOnce(new Error("socket gone"));
    const req = createMockRequest("/api/resources/tree", { method: "POST", body: { connection, parent: "a" } });
    const res = await treePOST(req as never);
    expect(mockRemove).toHaveBeenCalledWith("res-1");
    expect(res.status).toBe(500);
  });
});
