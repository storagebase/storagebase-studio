import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as realAuth from "@/lib/auth";
import type { SessionReading, UserPayload } from "@/lib/auth";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  ResourceConfigError,
  ResourceConnectionError,
  ResourceProviderUnavailableError,
} from "@/storagebase/resources/errors";

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

const fakeProvider = {
  getCapabilities: () => ({ category: "vault", defaultPort: 8200, supportsSshTunnel: false, operations: ["tree"] }),
  getLabels: () => ({ containerNoun: "Secrets", itemNoun: "Secret" }),
  getHealth: async () => ({ status: "healthy" as const }),
  listNodes: async () => ({ nodes: [], truncated: false }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockCreateResourceProvider = mock(async () => fakeProvider);

mock.module("@/storagebase/resources/factory", () => ({
  createResourceProvider: mockCreateResourceProvider,
  getOrCreateResourceProvider: mock(async () => fakeProvider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
  resourceConfigKey: mock(() => "key"),
}));

const { POST } = await import("@/app/api/sb/resources/meta/route");

const connection = {
  id: "res-1",
  name: "Test vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://vault:8200",
};

describe("POST /api/sb/resources/meta", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateResourceProvider.mockClear();
    mockCreateResourceProvider.mockImplementation(async () => fakeProvider);
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns 401 with the census shape when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(data).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
  });

  test("returns 400 for an empty body, a bare connection, and an unknown type", async () => {
    for (const body of [{}, { connection: { id: "x" } }, { connection: { ...connection, type: "postgres" } }]) {
      const req = createMockRequest("/api/sb/resources/meta", { method: "POST", body });
      const res = await POST(req as never);
      expect(res.status).toBe(400);
    }
    expect(mockCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("returns 200 with capabilities and labels without connecting", async () => {
    const req = createMockRequest("/api/sb/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ capabilities: { category: string }; labels: { containerNoun: string } }>(
      res,
    );
    expect(res.status).toBe(200);
    expect(data.capabilities.category).toBe("vault");
    expect(data.labels.containerNoun).toBe("Secrets");
    expect(mockCreateResourceProvider).toHaveBeenCalledTimes(1);
  });

  test("answers 501 with SB_RESOURCE_PROVIDER_UNAVAILABLE for an unregistered type with no loaders", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceProviderUnavailableError("kafka", []));
    const req = createMockRequest("/api/sb/resources/meta", {
      method: "POST",
      body: { connection: { ...connection, type: "kafka" } },
    });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(501);
    expect(data.code).toBe("SB_RESOURCE_PROVIDER_UNAVAILABLE");
  });

  test("answers 400 with SB_RESOURCE_CONFIG_ERROR for a 4xx resource error", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceConfigError("id required"));
    const req = createMockRequest("/api/sb/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(400);
    expect(data.code).toBe("SB_RESOURCE_CONFIG_ERROR");
  });

  test("answers 502 for a service-side connection refusal", async () => {
    mockCreateResourceProvider.mockRejectedValueOnce(new ResourceConnectionError("socket refused"));
    const req = createMockRequest("/api/sb/resources/meta", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);
    expect(res.status).toBe(502);
    expect(data.code).toBe("SB_RESOURCE_CONNECTION_ERROR");
  });
});
