import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest } from "../../helpers/mock-next";

/**
 * Every resource READ route emits exactly one `resource_operation` event: once on success with
 * its action, target and counts, once on failure with the reason — and the route's own answer is
 * unchanged either way (StorageBase fork). Content-leak proofs live in
 * tests/security/resource-audit-redaction.test.ts.
 */

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));
mock.module("@/lib/audit", () => ({ emitAuditEvent: mockEmitAuditEvent }));
mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => ({ session: { role: "user", username: "alice" } })),
  auditRoleDenial: mock(() => {}),
}));

let failing = false;
const answer =
  <T>(value: T) =>
  async (): Promise<T> => {
    if (failing) throw new Error("provider down");
    return value;
  };

const provider = {
  listBuckets: answer({ nodes: [], truncated: false }),
  readBlobMeta: answer({ id: "b/k", name: "k", sizeBytes: 42, lastModified: null, contentType: null }),
  downloadBlob: answer({ body: new ReadableStream(), contentType: null, sizeBytes: null }),
  previewBlob: answer({ kind: "binary", truncated: true, contentType: null }),
  listDestinations: answer({ nodes: [], truncated: false }),
  browseMessages: answer({ messages: [], truncated: false }),
  describeCluster: answer({ clusterId: "c", controllerId: 1, brokers: [{ id: 1 }, { id: 2 }] }),
  listTopicSummaries: answer({ topics: [{ name: "orders" }], countsTruncated: false }),
  describeTopic: answer({
    name: "orders",
    internal: false,
    partitions: [{}, {}, {}],
    configs: [{}],
    offsetsError: null,
  }),
  readMessages: answer({
    messages: [
      { partition: 0, offset: "10", valueBytes: 5 },
      { partition: 0, offset: "12", valueBytes: 7 },
    ],
    truncated: true,
  }),
  listConsumerGroups: answer({ groups: [{}, {}], lagTruncated: false }),
  describeConsumerGroup: answer({ groupId: "billing", members: [{}], offsets: [{}, {}] }),
  listNodes: answer({ nodes: [{}, {}, {}], truncated: true }),
  getHealth: answer({ status: "healthy", latencyMs: 9 }),
  getCapabilities: () => {
    if (failing) throw new Error("provider down");
    return {
      category: "blob",
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "blob.read", "blob.download", "message.browse", "kafka.inspect"],
    };
  },
  getLabels: () => ({ containerNoun: "C", itemNoun: "I" }),
};

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => provider),
  getOrCreateResourceProvider: mock(async () => provider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const connection = { id: "res-1", name: "store", type: "s3", createdAt: "2026-01-01T00:00:00.000Z" };

const cases: Array<[string, Record<string, unknown>, string, string, Record<string, unknown> | undefined]> = [
  ["tree", { parent: "bucket/b" }, "tree.list", "s3:bucket/b", { itemsListed: 3, truncated: true }],
  ["blob/preview", { bucket: "b", name: "k" }, "blob.preview", "s3:b/k", { byteLimit: 65536, truncated: true }],
  ["blob/download", { bucket: "b", name: "k" }, "blob.download", "s3:b/k", { bytes: null }],
  ["blob/meta", { bucket: "b", name: "k" }, "blob.meta", "s3:b/k", { bytes: 42 }],
  ["message/browse", { destination: "q" }, "message.browse", "s3:q", { messagesRead: 0, limit: 50, truncated: false }],
  ["health", {}, "resource.health", "s3:store", { healthy: true, latencyMs: 9 }],
  ["meta", {}, "resource.meta", "s3:store", undefined],
  ["kafka/cluster", {}, "kafka.cluster.read", "s3:store", { brokers: 2 }],
  ["kafka/topics", {}, "kafka.topics.list", "s3:store", { itemsListed: 1, truncated: false }],
  ["kafka/topic", { topic: "orders" }, "kafka.topic.read", "s3:orders", { partitions: 3, configs: 1 }],
  [
    "kafka/messages",
    { topic: "orders", seek: { mode: "offset", offset: "10" }, partition: 0, limit: 2 },
    "kafka.messages.read",
    "s3:orders[partition=0,seek=offset:10]",
    { messagesRead: 2, bytes: 12, limit: 2, truncated: true, firstOffset: 10, lastOffset: 12 },
  ],
  ["kafka/groups", {}, "kafka.groups.list", "s3:store", { itemsListed: 2, truncated: false }],
  ["kafka/group", { groupId: "billing" }, "kafka.group.read", "s3:billing", { members: 1, partitions: 2 }],
];

async function call(route: string, fields: Record<string, unknown>) {
  const { POST } = await import(`@/app/api/resources/${route}/route`);
  return POST(
    createMockRequest(`/api/resources/${route}`, {
      method: "POST",
      body: { connection, ...fields },
      headers: { "x-forwarded-for": "203.0.113.4", "user-agent": "read-audit-test" },
    }) as never,
  );
}

describe("resource read routes audit every read", () => {
  beforeEach(() => {
    failing = false;
    mockEmitAuditEvent.mockClear();
  });

  test.each(cases)("%s records one success", async (route, fields, action, target, counts) => {
    const res = await call(route, fields);
    expect(res.status).toBe(200);
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    const event = mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
    expect(event).toMatchObject({
      type: "resource_operation",
      action,
      target,
      result: "success",
      user: "alice",
      role: "user",
      ip: "203.0.113.4",
      userAgent: "read-audit-test",
      connectionId: "res-1",
      connectionName: "store",
      engine: "s3",
    });
    if (counts === undefined) expect(event).not.toHaveProperty("counts");
    else expect(event.counts).toEqual(counts);
  });

  test.each(cases)("%s records one failure and still answers with the error", async (route, fields, action) => {
    failing = true;
    const res = await call(route, fields);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action,
      result: "failure",
      reason: "resource_failed",
    });
  });

  test("a kafka read that returned nothing records no offset range", async () => {
    const original = provider.readMessages;
    provider.readMessages = answer({ messages: [], truncated: false }) as typeof provider.readMessages;
    try {
      await call("kafka/messages", { topic: "orders", seek: { mode: "timestamp", timestamp: 1700000000000 } });
      const event = mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
      expect(event.target).toBe("s3:orders[partition=all,seek=timestamp:1700000000000]");
      expect(event.counts).toEqual({ messagesRead: 0, bytes: 0, limit: 50, truncated: false });
    } finally {
      provider.readMessages = original;
    }
  });

  test("a request refused before the read ran is a 400 with no event", async () => {
    const res = await call("tree", { parent: "" });
    expect(res.status).toBe(400);
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });
});
