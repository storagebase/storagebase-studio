import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";

const mockTestResourceConnection = mock(
  async (): Promise<{ success: boolean; degraded: boolean; message: string; latencyMs?: number }> => ({
    success: true,
    degraded: false,
    message: "Connected",
  }),
);
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

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => ({})),
  getOrCreateResourceProvider: mock(async () => ({})),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mockTestResourceConnection,
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { POST } = await import("@/app/api/resources/test/route");

const connection = {
  id: "res-1",
  name: "Test vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://vault:8200",
};

describe("POST /api/resources/test", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockTestResourceConnection.mockClear();
    mockTestResourceConnection.mockImplementation(async () => ({
      success: true,
      degraded: false,
      message: "Connected",
    }));
    mockEmitAuditEvent.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns 401 when no session exists and parses no body", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(mockTestResourceConnection).not.toHaveBeenCalled();
  });

  test("returns 400 when the connection names no resource type", async () => {
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection: { id: "x" } } });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(mockTestResourceConnection).not.toHaveBeenCalled();
  });

  test("a healthy test answers success and records a success audit as the caller", async () => {
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    const event = mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
    expect(event).toMatchObject({
      type: "resource_connection_test",
      action: "tested",
      target: "hashicorp-vault:Test vault",
      user: "admin",
      result: "success",
    });
    expect(event).not.toHaveProperty("reason");
  });

  test("a refused test answers failure with resource_unreachable in the audit", async () => {
    mockTestResourceConnection.mockResolvedValueOnce({ success: false, degraded: false, message: "socket refused" });
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    const event = mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
    expect(event.result).toBe("failure");
    expect(event.reason).toBe("resource_unreachable");
  });

  test("a degraded test keeps success and carries the warning in the audit details", async () => {
    mockTestResourceConnection.mockResolvedValueOnce({
      success: true,
      degraded: true,
      message: "Connected, but the health check failed",
      latencyMs: 42,
    });
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ degraded: boolean }>(res);
    expect(data.degraded).toBe(true);
    const event = mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
    expect(event.result).toBe("success");
    expect(event.details).toContain("health check");
    expect(event.duration).toBe(42);
  });

  test("a broken audit sink cannot turn a probe into a 500", async () => {
    mockEmitAuditEvent.mockImplementationOnce(() => {
      throw new Error("ring buffer full");
    });
    const req = createMockRequest("/api/resources/test", { method: "POST", body: { connection } });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });
});
