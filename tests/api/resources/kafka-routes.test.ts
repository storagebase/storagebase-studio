import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { ResourceConflictError } from "@/lib/resources/errors";

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));

const mockGetSession = mock(
  async (): Promise<{ role: string; username?: string } | null> => ({ role: "admin", username: "admin" }),
);

// The guard is doubled rather than @/lib/auth (docs/BACKLOG.md D85 pins that
// mock's spread): a null session answers the guard's own 401.
mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => {
    const session = await mockGetSession();
    if (session === null) {
      const { NextResponse } = await import("next/server");
      return { response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
    }
    return { session };
  }),
  auditRoleDenial: mock(() => {}),
}));

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
}));

const kafka = {
  describeCluster: mock(async () => ({ clusterId: "c", controllerId: 1, brokers: [] })),
  listTopicSummaries: mock(async () => ({ topics: [], countsTruncated: false })),
  describeTopic: mock(async (_topic: string) => ({ name: "t", internal: false, partitions: [], configs: [] })),
  createTopic: mock(async (_input: unknown) => undefined),
  deleteTopic: mock(async (_topic: string) => undefined),
  addPartitions: mock(async (_topic: string, _count: number) => undefined),
  alterTopicConfigs: mock(async (_topic: string, _changes: unknown) => undefined),
  readMessages: mock(async (_topic: string, _query: unknown) => ({ messages: [], truncated: false })),
  produceMessage: mock(async (_topic: string, _input: unknown) => ({ partition: 0, offset: "7" })),
  listConsumerGroups: mock(async () => ({ groups: [], lagTruncated: false })),
  describeConsumerGroup: mock(async (_groupId: string) => ({
    groupId: "g",
    state: "Empty",
    protocolType: "consumer",
    protocol: "",
    members: [],
    offsets: [],
  })),
  resetConsumerGroupOffsets: mock(async (_input: unknown) => [] as unknown[]),
  deleteConsumerGroup: mock(async (_groupId: string) => undefined),
};

const fakeProvider = {
  ...kafka,
  getCapabilities: () => ({
    category: "messaging",
    defaultPort: 9092,
    supportsSshTunnel: false,
    operations: ["tree", "kafka.inspect", "kafka.topic.write", "kafka.produce", "kafka.group.write"],
  }),
  getLabels: () => ({ containerNoun: "Topics", itemNoun: "Messages" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockGetOrCreateResourceProvider = mock(async (): Promise<object> => fakeProvider);

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeProvider),
  getOrCreateResourceProvider: mockGetOrCreateResourceProvider,
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const routes = {
  cluster: (await import("@/app/api/resources/kafka/cluster/route")).POST,
  topics: (await import("@/app/api/resources/kafka/topics/route")).POST,
  topic: (await import("@/app/api/resources/kafka/topic/route")).POST,
  "topic/create": (await import("@/app/api/resources/kafka/topic/create/route")).POST,
  "topic/delete": (await import("@/app/api/resources/kafka/topic/delete/route")).POST,
  "topic/partitions": (await import("@/app/api/resources/kafka/topic/partitions/route")).POST,
  "topic/config": (await import("@/app/api/resources/kafka/topic/config/route")).POST,
  messages: (await import("@/app/api/resources/kafka/messages/route")).POST,
  produce: (await import("@/app/api/resources/kafka/produce/route")).POST,
  groups: (await import("@/app/api/resources/kafka/groups/route")).POST,
  group: (await import("@/app/api/resources/kafka/group/route")).POST,
  "group/reset-offsets": (await import("@/app/api/resources/kafka/group/reset-offsets/route")).POST,
  "group/delete": (await import("@/app/api/resources/kafka/group/delete/route")).POST,
};

type RouteName = keyof typeof routes;

const connection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "localhost:9092",
};

async function call(route: RouteName, body: Record<string, unknown>) {
  const req = createMockRequest(`/api/resources/kafka/${route}`, {
    method: "POST",
    body: { connection, ...body },
    headers: { "user-agent": "kafka-test-agent" },
  });
  return routes[route](req as never);
}

function auditEvents() {
  return mockEmitAuditEvent.mock.calls.map((entry) => entry[0] as Record<string, unknown>);
}

describe("kafka workbench routes", () => {
  beforeEach(() => {
    mockEmitAuditEvent.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeProvider);
    for (const fn of Object.values(kafka)) fn.mockClear();
  });

  test("reads answer the provider's page and audit nothing", async () => {
    for (const [route, body, fn] of [
      ["cluster", {}, kafka.describeCluster],
      ["topics", {}, kafka.listTopicSummaries],
      ["topic", { topic: "orders" }, kafka.describeTopic],
      ["groups", {}, kafka.listConsumerGroups],
      ["group", { groupId: "billing" }, kafka.describeConsumerGroup],
    ] as const) {
      const res = await call(route, body);
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(kafka.describeTopic).toHaveBeenCalledWith("orders");
    expect(kafka.describeConsumerGroup).toHaveBeenCalledWith("billing");
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });

  test("messages validate the seek and pass limit and partition through", async () => {
    expect((await call("messages", { topic: "orders", seek: { mode: "earliest" } })).status).toBe(200);
    expect(kafka.readMessages).toHaveBeenLastCalledWith("orders", { seek: { mode: "earliest" }, limit: 50 });

    await call("messages", { topic: "orders", seek: { mode: "offset", offset: "12" }, limit: 200, partition: 3 });
    expect(kafka.readMessages).toHaveBeenLastCalledWith("orders", {
      seek: { mode: "offset", offset: "12" },
      limit: 200,
      partition: 3,
    });
    await call("messages", { topic: "orders", seek: { mode: "timestamp", timestamp: 1700000000000 }, partition: null });
    expect(kafka.readMessages).toHaveBeenLastCalledWith("orders", {
      seek: { mode: "timestamp", timestamp: 1700000000000 },
      limit: 50,
    });
    await call("messages", { topic: "orders", seek: { mode: "latest" } });
    expect(kafka.readMessages).toHaveBeenCalledTimes(4);

    for (const body of [
      { topic: "orders" },
      { topic: "orders", seek: "earliest" },
      { topic: "orders", seek: { mode: "sideways" } },
      { topic: "orders", seek: { mode: "offset", offset: -1 } },
      { topic: "orders", seek: { mode: "offset", offset: "1.5" } },
      { topic: "orders", seek: { mode: "timestamp", timestamp: "now" } },
      { topic: "orders", seek: { mode: "timestamp", timestamp: -5 } },
      { topic: "orders", seek: { mode: "earliest" }, limit: 201 },
      { topic: "orders", seek: { mode: "earliest" }, partition: -1 },
      { topic: "bad topic!", seek: { mode: "earliest" } },
      { topic: "..", seek: { mode: "earliest" } },
    ]) {
      expect((await call("messages", body)).status).toBe(400);
    }
    expect(kafka.readMessages).toHaveBeenCalledTimes(4);
  });

  test("topic create validates, writes and records decision + outcome with one correlation id", async () => {
    const res = await call("topic/create", {
      topic: "orders",
      partitions: 3,
      replicationFactor: 1,
      configs: { "retention.ms": "1000" },
    });
    expect(res.status).toBe(200);
    expect(kafka.createTopic).toHaveBeenCalledWith({
      name: "orders",
      partitions: 3,
      replicationFactor: 1,
      configs: { "retention.ms": "1000" },
    });
    await call("topic/create", { topic: "bare", partitions: 1, replicationFactor: 1 });
    expect(kafka.createTopic).toHaveBeenLastCalledWith({ name: "bare", partitions: 1, replicationFactor: 1 });

    const events = auditEvents();
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "resource_operation",
      action: "kafka.topic.create",
      target: "kafka:topic/orders",
      user: "admin",
      userAgent: "kafka-test-agent",
    });
    expect(events[1]).toMatchObject({ userAgent: "kafka-test-agent" });
    expect(events[1].correlationId).toBe(events[0].correlationId);

    for (const body of [
      { topic: "orders", partitions: 0, replicationFactor: 1 },
      { topic: "orders", partitions: 1, replicationFactor: 1.5 },
      { topic: "orders", partitions: 1, replicationFactor: 1, configs: ["a"] },
      { topic: "orders", partitions: 1, replicationFactor: 1, configs: { a: 1 } },
    ]) {
      expect((await call("topic/create", body)).status).toBe(400);
    }
  });

  test("topic delete demands the typed name back", async () => {
    expect((await call("topic/delete", { topic: "orders" })).status).toBe(400);
    expect((await call("topic/delete", { topic: "orders", confirm: "order" })).status).toBe(400);
    expect(kafka.deleteTopic).not.toHaveBeenCalled();
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();

    const res = await call("topic/delete", { topic: "orders", confirm: "orders" });
    expect(res.status).toBe(200);
    expect(kafka.deleteTopic).toHaveBeenCalledWith("orders");
    expect(auditEvents()[0]).toMatchObject({ action: "kafka.topic.delete" });
  });

  test("partitions and config edits validate and audit", async () => {
    expect((await call("topic/partitions", { topic: "orders", count: 6 })).status).toBe(200);
    expect(kafka.addPartitions).toHaveBeenCalledWith("orders", 6);
    expect((await call("topic/partitions", { topic: "orders" })).status).toBe(400);

    const res = await call("topic/config", { topic: "orders", changes: { "retention.ms": "5", "segment.ms": null } });
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ altered: string[] }>(res)).altered).toEqual(["retention.ms", "segment.ms"]);
    for (const changes of [undefined, {}, ["x"], { "retention.ms": 5 }]) {
      expect((await call("topic/config", { topic: "orders", changes })).status).toBe(400);
    }
    expect(auditEvents().map((event) => event.action)).toEqual([
      "kafka.topic.partitions",
      "kafka.topic.partitions",
      "kafka.topic.config",
      "kafka.topic.config",
    ]);
  });

  test("produce passes key, headers and partition and answers where it landed", async () => {
    const res = await call("produce", { topic: "orders", value: "v", key: "k", headers: { h: "1" }, partition: 2 });
    expect(res.status).toBe(200);
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({ partition: 0, offset: "7" });
    expect(kafka.produceMessage).toHaveBeenCalledWith("orders", {
      value: "v",
      key: "k",
      headers: { h: "1" },
      partition: 2,
    });
    await call("produce", { topic: "orders", value: "" });
    expect(kafka.produceMessage).toHaveBeenLastCalledWith("orders", { value: "" });
    expect(auditEvents()[0]).toMatchObject({ action: "kafka.produce", target: "kafka:topic/orders" });

    for (const body of [
      { topic: "orders" },
      { topic: "orders", value: 1 },
      { topic: "orders", value: "v", key: 1 },
      { topic: "orders", value: "v", headers: { h: 1 } },
    ]) {
      expect((await call("produce", body)).status).toBe(400);
    }
  });

  test("offset resets validate the target and partitions, and a refusal is audited as a conflict", async () => {
    const res = await call("group/reset-offsets", {
      groupId: "billing",
      topic: "orders",
      reset: { mode: "offset", offset: "3" },
      partitions: [0, 1],
    });
    expect(res.status).toBe(200);
    expect(kafka.resetConsumerGroupOffsets).toHaveBeenCalledWith({
      groupId: "billing",
      topic: "orders",
      reset: { mode: "offset", offset: "3" },
      partitions: [0, 1],
    });
    await call("group/reset-offsets", { groupId: "billing", topic: "orders", reset: { mode: "latest" } });
    expect(kafka.resetConsumerGroupOffsets).toHaveBeenLastCalledWith({
      groupId: "billing",
      topic: "orders",
      reset: { mode: "latest" },
    });

    kafka.resetConsumerGroupOffsets.mockImplementationOnce(async () => {
      throw new ResourceConflictError("group is Stable");
    });
    mockEmitAuditEvent.mockClear();
    const refused = await call("group/reset-offsets", {
      groupId: "billing",
      topic: "orders",
      reset: { mode: "earliest" },
    });
    expect(refused.status).toBe(409);
    const events = auditEvents();
    expect(events[1]).toMatchObject({ result: "failure", reason: "resource_conflict" });

    for (const body of [
      { topic: "orders", reset: { mode: "earliest" } },
      { groupId: " ", topic: "orders", reset: { mode: "earliest" } },
      { groupId: "g", topic: "orders" },
      { groupId: "g", topic: "orders", reset: { mode: "earliest" }, partitions: [] },
      { groupId: "g", topic: "orders", reset: { mode: "earliest" }, partitions: [-1] },
      { groupId: "g", topic: "orders", reset: { mode: "earliest" }, partitions: "0" },
    ]) {
      expect((await call("group/reset-offsets", body)).status).toBe(400);
    }
  });

  test("group delete writes and audits under the caller's name — non-admins included, the resource-write precedent", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "alice" }));
    const res = await call("group/delete", { groupId: "billing" });
    expect(res.status).toBe(200);
    expect(kafka.deleteConsumerGroup).toHaveBeenCalledWith("billing");
    expect(auditEvents()[0]).toMatchObject({
      action: "kafka.group.delete",
      target: "kafka:group/billing",
      user: "alice",
    });
  });

  test("routes require a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await call("cluster", {})).status).toBe(401);
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("a connection without the workbench surface is a 400 the route decides", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeProvider,
      getCapabilities: () => ({ ...fakeProvider.getCapabilities(), operations: ["tree"] }),
    }));
    const res = await call("cluster", {});
    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ code: string }>(res)).code).toBe("RESOURCE_OPERATION_UNSUPPORTED");

    // Declared but not implemented: the downcast refuses too.
    const { describeCluster: _omit, ...withoutAdmin } = fakeProvider;
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => withoutAdmin);
    expect((await call("cluster", {})).status).toBe(400);
  });
});
