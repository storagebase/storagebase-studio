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

const fakeProvider = {
  getHealth: async () => ({ status: "healthy" as const, message: "ok", latencyMs: 7 }),
  listNodes: async () => ({ nodes: [], truncated: false }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockGetOrCreate = mock(async () => fakeProvider);
const mockRemove = mock(async () => undefined);

mock.module("@/storagebase/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeProvider),
  getOrCreateResourceProvider: mockGetOrCreate,
  removeResourceProvider: mockRemove,
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
  resourceConfigKey: mock(() => "key"),
}));

const { POST: healthPOST } = await import("@/app/api/sb/resources/health/route");
const { POST: treePOST } = await import("@/app/api/sb/resources/tree/route");

const connection = {
  id: "res-1",
  name: "Test",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("POST /api/sb/resources/health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreate.mockClear();
    mockGetOrCreate.mockImplementation(async () => fakeProvider);
    mockRemove.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the provider's health answer", async () => {
    const req = createMockRequest("/api/sb/resources/health", { method: "POST", body: { connection } });
    const res = await healthPOST(req as never);
    const data = await parseResponseJSON<{ status: string; latencyMs: number }>(res);
    expect(res.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.latencyMs).toBe(7);
  });

  test("returns 401 with the census shape when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/health", { method: "POST", body: { connection } });
    const res = await healthPOST(req as never);
    expect(res.status).toBe(401);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });

  test("a dead provider is evicted, then the refusal reaches the caller", async () => {
    mockGetOrCreate.mockRejectedValueOnce(new Error("socket gone"));
    const req = createMockRequest("/api/sb/resources/health", { method: "POST", body: { connection } });
    const res = await healthPOST(req as never);
    expect(mockRemove).toHaveBeenCalledWith("res-1");
    expect(res.status).toBe(500);
  });
});

describe("POST /api/sb/resources/tree", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreate.mockClear();
    mockGetOrCreate.mockImplementation(async () => fakeProvider);
    mockRemove.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the node page for the root level when no parent is named", async () => {
    const req = createMockRequest("/api/sb/resources/tree", { method: "POST", body: { connection } });
    const res = await treePOST(req as never);
    const data = await parseResponseJSON<{ nodes: unknown[]; truncated: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.nodes).toEqual([]);
    expect(data.truncated).toBe(false);
  });

  test("refuses a non-string and an empty parent without reaching the provider", async () => {
    for (const parent of ["", 42, ["a"]]) {
      const req = createMockRequest("/api/sb/resources/tree", { method: "POST", body: { connection, parent } });
      const res = await treePOST(req as never);
      expect(res.status).toBe(400);
    }
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  test("a dead provider is evicted, then the refusal reaches the caller", async () => {
    mockGetOrCreate.mockRejectedValueOnce(new Error("socket gone"));
    const req = createMockRequest("/api/sb/resources/tree", { method: "POST", body: { connection, parent: "a" } });
    const res = await treePOST(req as never);
    expect(mockRemove).toHaveBeenCalledWith("res-1");
    expect(res.status).toBe(500);
  });

  test("returns 401 with the census shape when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/resources/tree", { method: "POST", body: { connection } });
    const res = await treePOST(req as never);
    expect(res.status).toBe(401);
    expect(await parseResponseJSON<{ error: string; code: string }>(res)).toEqual({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  });
});
