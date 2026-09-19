import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceConfigError, ResourceConnectionError, ResourceProviderUnavailableError } from "@/lib/resources/errors";

const mockCreateResourceProvider = mock(async () => fakeProvider);

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

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mockCreateResourceProvider,
  getOrCreateResourceProvider: mock(async () => fakeProvider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const fakeProvider = {
  getCapabilities: () => ({ category: "blob", defaultPort: 443, supportsSshTunnel: false, operations: ["tree"] }),
  getLabels: () => ({ containerNoun: "Buckets", itemNoun: "Objects" }),
  getHealth: async () => ({ status: "healthy" as const }),
  listNodes: async () => ({ nodes: [], truncated: false }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const { POST } = await import("@/app/api/resources/meta/route");

const connection = {
  id: "res-1",
  name: "Test bucket",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("POST /api/resources/meta", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateResourceProvider.mockClear();
    mockCreateResourceProvider.mockImplementation(async () => fakeProvider);
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);
    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns 400 for an empty body, a bare connection, and an unknown type", async () => {
    for (const body of [{}, { connection: { id: "x" } }, { connection: { ...connection, type: "postgres" } }]) {
      const req = createMockRequest("/api/resources/meta", { method: "POST", body });
      const res = await POST(req as never);
      expect(res.status).toBe(400);
    }
  });

  test("returns 200 with capabilities and labels without connecting", async () => {
    const req = createMockRequest("/api/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ capabilities: { category: string }; labels: { containerNoun: string } }>(
      res,
    );
    expect(res.status).toBe(200);
    expect(data.capabilities.category).toBe("blob");
    expect(data.labels.containerNoun).toBe("Buckets");
  });

  test("answers 501 with RESOURCE_PROVIDER_UNAVAILABLE for an unregistered type with no loaders", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceProviderUnavailableError("kafka", []));
    const req = createMockRequest("/api/resources/meta", {
      method: "POST",
      body: { connection: { ...connection, type: "kafka" } },
    });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(501);
    expect(data.code).toBe("RESOURCE_PROVIDER_UNAVAILABLE");
  });

  test("answers 400 with RESOURCE_CONFIG_ERROR for a 4xx resource error", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceConfigError("id required"));
    const req = createMockRequest("/api/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(400);
    expect(data.code).toBe("RESOURCE_CONFIG_ERROR");
  });

  test("answers 502 for a service-side connection refusal", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceConnectionError("socket refused"));
    const req = createMockRequest("/api/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(502);
    expect(data.code).toBe("RESOURCE_CONNECTION_ERROR");
  });
});
