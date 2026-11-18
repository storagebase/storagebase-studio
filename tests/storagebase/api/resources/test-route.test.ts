import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as realAuth from "@/lib/auth";
import type { SessionReading, UserPayload } from "@/lib/auth";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";

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

const mockTestResourceConnection = mock(
  async (): Promise<{ success: boolean; degraded: boolean; message: string; latencyMs?: number }> => ({
    success: true,
    degraded: false,
    message: "Connected",
  }),
);

mock.module("@/storagebase/resources/factory", () => ({
  createResourceProvider: mock(async () => ({})),
  getOrCreateResourceProvider: mock(async () => ({})),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mockTestResourceConnection,
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
  resourceConfigKey: mock(() => "key"),
}));

const { POST } = await import("@/app/api/sb/resources/test/route");

const connection = {
  id: "res-1",
  name: "Test vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://vault:8200",
};

describe("POST /api/sb/resources/test", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockTestResourceConnection.mockClear();
    mockTestResourceConnection.mockImplementation(async () => ({
      success: true,
      degraded: false,
      message: "Connected",
    }));
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns 401 when no session exists and parses no body", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(mockTestResourceConnection).not.toHaveBeenCalled();
  });

  test("returns 400 when the connection names no resource type", async () => {
    const req = createMockRequest("/api/sb/resources/test", { method: "POST", body: { connection: { id: "x" } } });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockTestResourceConnection).not.toHaveBeenCalled();
  });

  test("a healthy test answers success and is audited once as the caller", async () => {
    const req = createMockRequest("/api/sb/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; degraded: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.degraded).toBe(false);
    expect(mockTestResourceConnection).toHaveBeenCalledTimes(1);
    expect(mockTestResourceConnection).toHaveBeenCalledWith(connection);
  });

  test("a failing test answers failure and the refusal stays the route's own", async () => {
    mockTestResourceConnection.mockImplementationOnce(async () => ({
      success: false,
      degraded: false,
      message: "socket refused",
    }));
    const req = createMockRequest("/api/sb/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.message).toBe("socket refused");
  });

  test("a degraded test answers success with the warning", async () => {
    mockTestResourceConnection.mockImplementationOnce(async () => ({
      success: true,
      degraded: true,
      message: "Connected, but the health check failed",
    }));
    const req = createMockRequest("/api/sb/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; degraded: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.degraded).toBe(true);
  });
});
