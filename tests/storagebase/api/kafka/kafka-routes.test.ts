import { describe, test, expect, beforeEach } from "bun:test";
import { createMockRequest as rawRequest, parseResponseJSON } from "../../../helpers/mock-next";
import type { NextRequest } from "next/server";

const createMockRequest = (...args: Parameters<typeof rawRequest>): NextRequest =>
  rawRequest(...args) as unknown as NextRequest;
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  calls,
  mockGetSession,
  mockResolveConnection,
  reads,
  resetHarness,
  responses,
  writes,
  upstreamConnection,
} from "./harness";

const { POST: cluster } = await import("@/app/api/sb/kafka/cluster/route");
const { POST: topics } = await import("@/app/api/sb/kafka/topics/route");
const { POST: counts } = await import("@/app/api/sb/kafka/topics/counts/route");
const { POST: topic } = await import("@/app/api/sb/kafka/topic/route");
const { POST: config } = await import("@/app/api/sb/kafka/topic/config/route");
const { POST: create } = await import("@/app/api/sb/kafka/topic/create/route");
const { POST: partitions } = await import("@/app/api/sb/kafka/topic/partitions/route");
const { POST: removeTopic } = await import("@/app/api/sb/kafka/topic/delete/route");
const { POST: messages } = await import("@/app/api/sb/kafka/messages/route");
const { POST: produce } = await import("@/app/api/sb/kafka/produce/route");
const { POST: groups } = await import("@/app/api/sb/kafka/groups/route");
const { POST: lag } = await import("@/app/api/sb/kafka/groups/lag/route");
const { POST: group } = await import("@/app/api/sb/kafka/group/route");
const { POST: reset } = await import("@/app/api/sb/kafka/group/reset-offsets/route");
const { POST: removeGroup } = await import("@/app/api/sb/kafka/group/delete/route");

const connection = { connectionId: "seed:kafka-1" };

describe("Kafka workbench routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    resetHarness();
  });

  test("read routes answer the provider's data and record one audit read each", async () => {
    responses.describeCluster = { clusterId: "c", brokers: [{ nodeId: 1 }], controllerId: 1 };
    responses.listTopicSummaries = { topics: [{ name: "orders" }] };
    responses.countTopicMessages = { orders: { messageCount: 5, countError: null } };
    responses.describeTopic = { name: "orders", partitions: [], configs: [], offsetsError: null };
    responses.readMessages = { messages: [{ offset: "1", valueBytes: 3 }], truncated: false };
    responses.listConsumerGroups = { groups: [{ groupId: "g" }] };
    responses.measureGroupLag = { g: { totalLag: 2, lagError: null, topics: 1 } };
    responses.describeConsumerGroup = { groupId: "g", members: [], offsets: [] };

    expect(
      await parseResponseJSON(
        await cluster(createMockRequest("/api/sb/kafka/cluster", { method: "POST", body: connection })),
      ),
    ).toEqual(responses.describeCluster);
    expect(
      await parseResponseJSON(
        await topics(createMockRequest("/api/sb/kafka/topics", { method: "POST", body: connection })),
      ),
    ).toEqual(responses.listTopicSummaries);
    expect(
      await parseResponseJSON(
        await counts(
          createMockRequest("/api/sb/kafka/topics/counts", {
            method: "POST",
            body: { ...connection, topics: ["orders"] },
          }),
        ),
      ),
    ).toEqual({ counts: responses.countTopicMessages });
    expect(
      await parseResponseJSON(
        await topic(
          createMockRequest("/api/sb/kafka/topic", { method: "POST", body: { ...connection, topic: "orders" } }),
        ),
      ),
    ).toEqual(responses.describeTopic);
    expect(
      await parseResponseJSON(
        await messages(
          createMockRequest("/api/sb/kafka/messages", {
            method: "POST",
            body: { ...connection, topic: "orders", seek: { mode: "earliest" } },
          }),
        ),
      ),
    ).toEqual(responses.readMessages);
    expect(
      await parseResponseJSON(
        await groups(createMockRequest("/api/sb/kafka/groups", { method: "POST", body: connection })),
      ),
    ).toEqual(responses.listConsumerGroups);
    expect(
      await parseResponseJSON(
        await lag(
          createMockRequest("/api/sb/kafka/groups/lag", { method: "POST", body: { ...connection, groupIds: ["g"] } }),
        ),
      ),
    ).toEqual({ lags: responses.measureGroupLag });
    expect(
      await parseResponseJSON(
        await group(
          createMockRequest("/api/sb/kafka/group", { method: "POST", body: { ...connection, groupId: "g" } }),
        ),
      ),
    ).toEqual(responses.describeConsumerGroup);

    expect(reads).toHaveLength(8);
    expect(reads.map((read) => read.action)).toEqual([
      "kafka.cluster.read",
      "kafka.topics.list",
      "kafka.topics.counts",
      "kafka.topic.read",
      "kafka.messages.read",
      "kafka.groups.list",
      "kafka.groups.lag",
      "kafka.group.read",
    ]);
    expect(reads[0].counts).toEqual({ brokers: 1 });
    expect(reads[4].counts).toMatchObject({ messagesRead: 1, bytes: 3, limit: 50 });
    expect(calls.filter((call) => call.method === "constructor")).toHaveLength(8);
  });

  test("write routes answer and emit a decision + outcome pair", async () => {
    const req = (route: string, body: Record<string, unknown>) =>
      createMockRequest(`/api/sb/kafka/${route}`, { method: "POST", body: { ...connection, ...body } });

    expect(
      await parseResponseJSON(
        await create(
          req("topic/create", { topic: "orders", partitions: 2, replicationFactor: 1, configs: { a: "b" } }),
        ),
      ),
    ).toEqual({ created: true });
    expect(await parseResponseJSON(await partitions(req("topic/partitions", { topic: "orders", count: 4 })))).toEqual({
      partitions: 4,
    });
    expect(
      await parseResponseJSON(
        await config(req("topic/config", { topic: "orders", changes: { "cleanup.policy": "compact" } })),
      ),
    ).toEqual({ altered: ["cleanup.policy"] });
    responses.produceMessage = { partition: 0, offset: "9" };
    expect(
      await parseResponseJSON(
        await produce(req("produce", { topic: "orders", value: "v", key: "k", headers: { h: "v" } })),
      ),
    ).toEqual(responses.produceMessage);

    expect(writes).toHaveLength(8); // four writes, two events each
    expect(writes.map((write) => write.action)).toEqual([
      "kafka.topic.create",
      "kafka.topic.create",
      "kafka.topic.partitions",
      "kafka.topic.partitions",
      "kafka.topic.config",
      "kafka.topic.config",
      "kafka.produce",
      "kafka.produce",
    ]);
    expect(calls.map((call) => call.method)).toContain("createTopic");
    expect(calls.map((call) => call.method)).toContain("produceMessage");
  });

  test("admin routes answer and enforce the admin role", async () => {
    const req = (route: string, body: Record<string, unknown>) =>
      createMockRequest(`/api/sb/kafka/${route}`, { method: "POST", body: { ...connection, ...body } });

    expect(
      await parseResponseJSON(await removeTopic(req("topic/delete", { topic: "orders", confirm: "orders" }))),
    ).toEqual({ deleted: true });
    responses.resetConsumerGroupOffsets = [
      { topic: "orders", partition: 0, committedOffset: "1", endOffset: "2", lag: 1, endOffsetError: null },
    ];
    expect(
      await parseResponseJSON(
        await reset(req("group/reset-offsets", { groupId: "g", topic: "orders", reset: { mode: "earliest" } })),
      ),
    ).toEqual({ offsets: responses.resetConsumerGroupOffsets });
    expect(await parseResponseJSON(await removeGroup(req("group/delete", { groupId: "g" })))).toEqual({
      deleted: true,
    });

    mockGetSession.mockImplementation(async () => ({ role: "user", username: "reader" }));
    const refused = await removeGroup(req("group/delete", { groupId: "g" }));
    expect(refused.status).toBe(403);
    expect(await parseResponseJSON(refused)).toMatchObject({ error: "Unauthorized. Admin access required." });
    expect(calls.some((call) => call.method === "deleteConsumerGroup")).toBe(true);
  });

  test("readOnly connections cannot write, and a non-messaging connection is refused", async () => {
    mockResolveConnection.mockImplementation(async () => ({ ...upstreamConnection, readOnly: true }));
    const refused = await create(
      createMockRequest("/api/sb/kafka/topic/create", {
        method: "POST",
        body: { ...connection, topic: "orders", partitions: 1, replicationFactor: 1 },
      }),
    );
    expect(refused.status).toBe(403);
    expect(await parseResponseJSON(refused)).toMatchObject({ code: "SB_RESOURCE_ACCESS_DENIED" });

    mockResolveConnection.mockImplementation(async () => ({ ...upstreamConnection, type: "postgres" }));
    const wrong = await cluster(createMockRequest("/api/sb/kafka/cluster", { method: "POST", body: connection }));
    expect(wrong.status).toBe(400);
    expect(await parseResponseJSON(wrong)).toMatchObject({ code: "SB_RESOURCE_INVALID_REQUEST" });
  });

  test("every route returns the exact 401 before a body is parsed", async () => {
    mockGetSession.mockImplementation(async () => null);
    const handlers = [
      cluster,
      topics,
      counts,
      topic,
      config,
      create,
      partitions,
      removeTopic,
      messages,
      produce,
      groups,
      lag,
      group,
      reset,
      removeGroup,
    ];
    for (const handler of handlers) {
      const res = await handler(
        createMockRequest("/api/sb/kafka/probe", {
          method: "POST",
          body: { probe: true },
        }),
      );
      expect(res.status).toBe(401);
      expect(await parseResponseJSON(res)).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    }
    expect(calls).toHaveLength(0);
  });

  test("empty or malformed bodies are refused before resolution", async () => {
    const empty = await cluster(createMockRequest("/api/sb/kafka/cluster", { method: "POST", body: {} }));
    expect(empty.status).toBe(400);
    expect(await parseResponseJSON(empty)).toMatchObject({ error: "Empty request body" });
    const malformed = new Request("http://localhost/api/sb/kafka/cluster", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const bad = await cluster(malformed as never);
    expect(bad.status).toBe(400);
    expect(await parseResponseJSON(bad)).toMatchObject({ error: "Empty request body" });
    expect(calls).toHaveLength(0);
  });

  test("a failing write records a failure outcome before the error is mapped", async () => {
    const { ResourceConflictError } = await import("@/storagebase/resources/errors");
    const original = responses.createTopic;
    responses.createTopic = () => {
      throw new ResourceConflictError("topic exists");
    };
    const req = createMockRequest("/api/sb/kafka/topic/create", {
      method: "POST",
      body: { ...connection, topic: "orders", partitions: 1, replicationFactor: 1 },
    });
    const res = await create(req);
    expect(res.status).toBe(409);
    expect(writes[1]).toMatchObject({ kind: "outcome", error: expect.any(Error) });
    responses.createTopic = original;
  });

  test("validation refusals name the offending field", async () => {
    const cases: Array<[typeof cluster, Record<string, unknown>, string]> = [
      [topic, { topic: "bad name" }, '"topic"'],
      [group, { groupId: "  " }, '"groupId"'],
      [counts, { topics: [] }, '"topics"'],
      [counts, { topics: ["bad name"] }, '"topics" holds'],
      [create, { topic: "orders", partitions: 0, replicationFactor: 1 }, '"partitions"'],
      [create, { topic: "orders", partitions: 1, replicationFactor: 99 }, '"replicationFactor"'],
      [create, { topic: "orders", partitions: 1, replicationFactor: 1, configs: { a: 1 } }, '"configs.a"'],
      [partitions, { topic: "orders", count: 0 }, '"count"'],
      [removeTopic, { topic: "orders" }, '"confirm"'],
      [messages, { topic: "orders", seek: { mode: "nope" } }, '"seek.mode"'],
      [messages, { topic: "orders", seek: { mode: "offset", offset: "-1" } }, '"seek.offset"'],
      [messages, { topic: "orders", seek: { mode: "timestamp", timestamp: -1 } }, '"seek.timestamp"'],
      [messages, { topic: "orders", seek: { mode: "earliest" }, limit: 999 }, '"limit"'],
      [messages, { topic: "orders", seek: { mode: "earliest" }, partition: -1 }, '"partition"'],
      [produce, { topic: "orders" }, '"value"'],
      [produce, { topic: "orders", value: "v", key: 3 }, '"key"'],
      [produce, { topic: "orders", value: "v", headers: [] }, '"headers"'],
      [produce, { topic: "orders", value: "v", headers: { h: 3 } }, '"headers.h"'],
      [config, { topic: "orders", changes: {} }, '"changes"'],
      [config, { topic: "orders", changes: { a: 3 } }, '"changes.a"'],
      [lag, { groupIds: [" "] }, '"groupIds" holds'],
      [reset, { groupId: "g", topic: "orders", reset: { mode: "nope" } }, '"seek.mode"'],
      [reset, { groupId: "g", topic: "orders", reset: { mode: "earliest" }, partitions: [] }, '"partitions"'],
    ];
    for (const [handler, body, needle] of cases) {
      const res = await handler(
        createMockRequest("/api/sb/kafka/validate", {
          method: "POST",
          body: { ...connection, ...body },
        }),
      );
      expect(res.status, needle).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(res)).error, needle).toContain(needle);
    }
  });
});
