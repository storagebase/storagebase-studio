import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceConnectionError } from "@/lib/resources/errors";
import type { BrowseMessagesPage } from "@/lib/resources/operations";

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

const mockBrowseMessages = mock(
  async (_destination: string, _limit: number): Promise<BrowseMessagesPage> => ({ messages: [], truncated: false }),
);

const fakeMessaging = {
  listDestinations: async () => ({ nodes: [], truncated: false }),
  browseMessages: mockBrowseMessages,
  publishMessage: mock(async () => undefined),
  purgeQueue: mock(async () => undefined),
  getCapabilities: () => ({
    category: "messaging",
    defaultPort: 9092,
    supportsSshTunnel: false,
    operations: ["tree", "message.browse", "message.publish", "message.purge"],
  }),
  getLabels: () => ({ containerNoun: "Topics", itemNoun: "Messages" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockGetOrCreateResourceProvider = mock(async () => fakeMessaging);

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeMessaging),
  getOrCreateResourceProvider: mockGetOrCreateResourceProvider,
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { POST: postBrowse } = await import("@/app/api/resources/message/browse/route");
const { POST: postPublish } = await import("@/app/api/resources/message/publish/route");
const { POST: postPurge } = await import("@/app/api/resources/message/purge/route");

const connection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "localhost:9092",
};

function auditEvents() {
  return mockEmitAuditEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe("message routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeMessaging);
    mockBrowseMessages.mockClear();
  });

  test("browse answers the page and audits one message.browse read", async () => {
    mockBrowseMessages.mockResolvedValueOnce({
      messages: [{ id: "topic/t/0/0", parentId: "topic/t", kind: "message", name: "#0", hasChildren: false }],
      truncated: false,
    });
    const req = createMockRequest("/api/resources/message/browse", {
      method: "POST",
      body: { connection, destination: "topic/fixture-events", limit: 10 },
    });
    const res = await postBrowse(req as never);
    const data = await parseResponseJSON<{ messages: unknown[] }>(res);
    expect(res.status).toBe(200);
    expect(data.messages).toHaveLength(1);
    expect(mockBrowseMessages).toHaveBeenCalledWith("topic/fixture-events", 10);
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: "message.browse",
      result: "success",
      counts: { messagesRead: 1, limit: 10, truncated: false },
    });
  });

  test("browse validates destination and limit", async () => {
    for (const body of [
      { connection, destination: "", limit: 10 },
      { connection },
      { connection, destination: "topic/t", limit: 0 },
      { connection, destination: "topic/t", limit: 101 },
      { connection, destination: "topic/t", limit: 2.5 },
    ]) {
      const req = createMockRequest("/api/resources/message/browse", { method: "POST", body });
      expect((await postBrowse(req as never)).status).toBe(400);
    }
    expect(mockBrowseMessages).not.toHaveBeenCalled();
  });

  test("publish writes and records decision + outcome with one correlation id", async () => {
    const req = createMockRequest("/api/resources/message/publish", {
      method: "POST",
      body: { connection, destination: "topic/fixture-events", body: "hello", attributes: { key: "k1" } },
    });
    const res = await postPublish(req as never);
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ published: boolean }>(res)).published).toBe(true);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "resource_operation", action: "message.publish", result: "success" });
    expect(events[1]).toMatchObject({ result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
    expect(events[1]).not.toHaveProperty("reason");
  });

  test("publish validates body and attributes", async () => {
    for (const body of [
      { connection, destination: "topic/t" },
      { connection, destination: "topic/t", body: "" },
      { connection, destination: "topic/t", body: "x", attributes: ["k"] },
      { connection, destination: "topic/t", body: "x", attributes: { k: 42 } },
    ]) {
      const req = createMockRequest("/api/resources/message/publish", { method: "POST", body });
      expect((await postPublish(req as never)).status).toBe(400);
    }
  });

  test("purge removes and records decision + outcome", async () => {
    const req = createMockRequest("/api/resources/message/purge", {
      method: "POST",
      body: { connection, destination: "queue/orders" },
    });
    const res = await postPurge(req as never);
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ purged: boolean }>(res)).purged).toBe(true);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "message.purge", result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("a provider failure on purge is a 502 with resource_failed in the outcome", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeMessaging,
      purgeQueue: mock(async () => {
        throw new ResourceConnectionError("channel closed");
      }),
    }));
    const req = createMockRequest("/api/resources/message/purge", {
      method: "POST",
      body: { connection, destination: "queue/orders" },
    });
    expect((await postPurge(req as never)).status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "message.purge", result: "failure", reason: "resource_failed" });
  });

  test("routes require a session and parse no body without one", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/message/purge", {
      method: "POST",
      body: { connection, destination: "queue/orders" },
    });
    expect((await postPurge(req as never)).status).toBe(401);
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeMessaging,
      getCapabilities: () => ({ ...fakeMessaging.getCapabilities(), operations: ["tree"] }),
    }));
    const req = createMockRequest("/api/resources/message/publish", {
      method: "POST",
      body: { connection, destination: "topic/t", body: "x" },
    });
    const res = await postPublish(req as never);
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("RESOURCE_OPERATION_UNSUPPORTED");
  });
});
