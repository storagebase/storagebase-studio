import { describe, expect, test } from "bun:test";
import {
  isKafkaOffsetReset,
  KafkaProvider,
  KAFKA_MEASURE_BATCH_LIMIT,
} from "@/storagebase/resources/providers/messaging/kafka";
import {
  ResourceConflictError,
  ResourceConnectionError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
} from "@/storagebase/resources/errors";
import { fakeWire, fakeWireState, metadata } from "../unit/kafka/fake-wire";

const config = { host: "b1", port: 9092 };
const provider = (state = fakeWireState()) => {
  const { wire } = fakeWire(state);
  return { kafka: new KafkaProvider(config, { wire }), state };
};
const protocolError = (apiId: string) => Object.assign(new Error("broker refused"), { apiId });

describe("KafkaProvider — cluster and topics", () => {
  test("describes the cluster with brokers sorted and the controller marked", async () => {
    const { kafka } = provider();
    const overview = await kafka.describeCluster();
    expect(overview.clusterId).toBe("c-1");
    expect(overview.brokers.map((b) => b.nodeId)).toEqual([1, 2]);
    expect(overview.brokers[0].isController).toBe(true);
    expect(overview.brokers[0].rack).toBe("r1");
    expect(overview.brokers[1].rack).toBeNull();
  });

  test("lists non-internal topics as metadata with under-replication", async () => {
    const { kafka } = provider();
    const listing = await kafka.listTopicSummaries();
    expect(listing.topics.map((t) => t.name)).toEqual(["orders"]);
    expect(listing.topics[0]).toMatchObject({ partitions: 2, replicationFactor: 2, underReplicatedPartitions: 1 });
  });

  test("counts a batch, with a missing topic and a failed offset read answered best effort", async () => {
    const { kafka } = provider();
    expect(await kafka.countTopicMessages(["orders", "orders", "gone"])).toEqual({
      orders: { messageCount: 20, countError: null },
      gone: { messageCount: null, countError: "topic does not exist or has no partitions" },
    });
    expect(await kafka.countTopicMessages([])).toEqual({});
    expect(() =>
      kafka.countTopicMessages(Array.from({ length: KAFKA_MEASURE_BATCH_LIMIT + 1 }, (_, i) => `t${i}`)),
    ).toThrow(ResourceInvalidRequestError);

    const state = fakeWireState({ fail: "listOffsets" });
    const { kafka: broken } = provider(state);
    const counts = await broken.countTopicMessages(["orders"]);
    expect(counts.orders.messageCount).toBeNull();
    expect(counts.orders.countError).toContain("fake failure");
  });

  test("describes a topic with partitions, configs and offsets, and survives an offset failure", async () => {
    const { kafka } = provider();
    const detail = await kafka.describeTopic("orders");
    expect(detail.partitions).toHaveLength(2);
    expect(detail.partitions[0].earliestOffset).toBe("2");
    expect(detail.partitions[0].latestOffset).toBe("12");
    expect(detail.configs.map((c) => c.name)).toEqual(["cleanup.policy", "password", "retention.ms"]);
    expect(detail.configs[1].value).toBeNull();
    expect(detail.configs[2].isDefault).toBe(true);
    expect(detail.offsetsError).toBeNull();

    const state = fakeWireState({ md: metadata({ topics: new Map() }) });
    const { kafka: empty } = provider(state);
    expect((await empty.describeTopic("orders")).offsetsError).toBe("no partition metadata");
  });

  test("translates broker refusals into the fork's typed errors", async () => {
    const state = fakeWireState();
    const f = fakeWire(state);
    f.admin.createTopics = async () => {
      throw protocolError("INVALID_REPLICATION_FACTOR");
    };
    const kafka = new KafkaProvider(config, { wire: f.wire });
    await expect(kafka.createTopic({ name: "orders", partitions: 1, replicationFactor: 9 })).rejects.toThrow(
      ResourceInvalidRequestError,
    );

    const state2 = fakeWireState();
    const f2 = fakeWire(state2);
    f2.admin.listTopics = async () => {
      throw protocolError("TOPIC_ALREADY_EXISTS");
    };
    const k2 = new KafkaProvider(config, { wire: f2.wire });
    await expect(k2.deleteTopic("orders")).rejects.toThrow(ResourceConflictError);
    // An error with no protocol id is a connection failure carrying the broker's sentence.
    const f3 = fakeWire(fakeWireState());
    f3.admin.listTopics = async () => {
      throw new Error("socket gone");
    };
    await expect(new KafkaProvider(config, { wire: f3.wire }).listTopicSummaries()).rejects.toThrow(
      ResourceConnectionError,
    );
  });
});

describe("KafkaProvider — topic writes", () => {
  test("creates a topic with configs, and refuses an empty answer as a conflict", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    await kafka.createTopic({ name: "orders", partitions: 3, replicationFactor: 2, configs: { a: "b" } });
    expect(state.created).toHaveLength(1);

    const conflict = fakeWireState();
    const f = fakeWire(conflict);
    f.admin.createTopics = async () => [];
    const k2 = new KafkaProvider(config, { wire: f.wire });
    await expect(k2.createTopic({ name: "orders", partitions: 1, replicationFactor: 1 })).rejects.toThrow(
      ResourceConflictError,
    );
  });

  test("deletes a topic after checking it exists", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    await kafka.deleteTopic("orders");
    expect(state.deletedTopics).toHaveLength(1);
    await expect(kafka.deleteTopic("gone")).rejects.toThrow(ResourceNotFoundError);
  });

  test("adds partitions only upwards", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    await kafka.addPartitions("orders", 4);
    expect(state.partitioned).toHaveLength(1);
    await expect(kafka.addPartitions("orders", 1)).rejects.toThrow(ResourceConflictError);
  });

  test("alters configs with SET and DELETE operations", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    await kafka.alterTopicConfigs("orders", { "cleanup.policy": "compact", "retention.ms": null });
    expect(state.altered).toHaveLength(1);
  });
});

describe("KafkaProvider — messages", () => {
  test("reads a bounded page and decodes keys, values and headers", async () => {
    const { kafka } = provider();
    const page = await kafka.readMessages("orders", { seek: { mode: "earliest" }, limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      partition: 0,
      offset: "4",
      key: "k",
      value: '{"a":1}',
      valueEncoding: "utf8",
      headers: { h: "v" },
      valueBytes: 7,
    });
  });

  test("supports latest, offset and timestamp seeks", async () => {
    const { kafka } = provider();
    // "latest" starts at the current end: nothing has arrived yet, so the window is empty.
    expect((await kafka.readMessages("orders", { seek: { mode: "latest" }, limit: 10 })).messages).toHaveLength(0);
    expect(
      (await kafka.readMessages("orders", { seek: { mode: "offset", offset: "3" }, limit: 10 })).messages,
    ).toHaveLength(1);
    expect(
      (await kafka.readMessages("orders", { seek: { mode: "timestamp", timestamp: 1700000000000 }, limit: 10 }))
        .messages,
    ).toHaveLength(1);
  });

  test("sorts records by time, then partition, then offset", async () => {
    const state = fakeWireState({
      messages: [
        {
          topic: "orders",
          partition: 1,
          offset: BigInt(6),
          timestamp: BigInt(2),
          key: null,
          value: null,
          headers: new Map(),
        },
        {
          topic: "orders",
          partition: 0,
          offset: BigInt(7),
          timestamp: BigInt(2),
          key: null,
          value: null,
          headers: new Map(),
        },
        {
          topic: "orders",
          partition: 0,
          offset: BigInt(5),
          timestamp: BigInt(1),
          key: null,
          value: null,
          headers: new Map(),
        },
      ],
    });
    const page = await new KafkaProvider(config, { wire: fakeWire(state).wire }).readMessages("orders", {
      seek: { mode: "earliest" },
      limit: 10,
    });
    expect(page.messages.map((message) => message.offset)).toEqual(["5", "7", "6"]);
  });

  test("answers an empty window, a partition miss and a base64 value", async () => {
    const empty = fakeWireState({ high: BigInt(2), low: BigInt(2) });
    expect(
      (
        await new KafkaProvider(config, { wire: fakeWire(empty).wire }).readMessages("orders", {
          seek: { mode: "earliest" },
          limit: 10,
        })
      ).messages,
    ).toEqual([]);
    await expect(
      new KafkaProvider(config, { wire: fakeWire(fakeWireState()).wire }).readMessages("orders", {
        seek: { mode: "earliest" },
        limit: 10,
        partition: 9,
      }),
    ).rejects.toThrow(ResourceNotFoundError);

    const binary = fakeWireState({
      messages: [
        {
          topic: "orders",
          partition: 0,
          offset: BigInt(1),
          timestamp: BigInt(1),
          key: null,
          value: new Uint8Array([0xff, 0xfe]),
          headers: new Map(),
        },
      ],
    });
    const page = await new KafkaProvider(config, { wire: fakeWire(binary).wire }).readMessages("orders", {
      seek: { mode: "earliest" },
      limit: 10,
    });
    expect(page.messages[0].valueEncoding).toBe("base64");
    expect(page.messages[0].key).toBeNull();
  });
});

describe("KafkaProvider — produce and consumer groups", () => {
  test("produces after existence check and reports the ack", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    const result = await kafka.produceMessage("orders", { value: "v", key: "k", headers: { h: "v" }, partition: 0 });
    expect(result).toEqual({ partition: 0, offset: "9" });
    expect(state.sent).toHaveLength(1);
    await expect(kafka.produceMessage("gone", { value: "v" })).rejects.toThrow(ResourceNotFoundError);
  });

  test("lists consumer groups with internal flag and state", async () => {
    const state = fakeWireState({
      groups: new Map([["storagebase-peek-1", { id: "storagebase-peek-1", state: "Empty", protocolType: "consumer" }]]),
      described: new Map([
        ["storagebase-peek-1", { state: "Empty", protocolType: "consumer", protocol: "range", members: new Map() }],
      ]),
    });
    const listing = await new KafkaProvider(config, { wire: fakeWire(state).wire }).listConsumerGroups();
    expect(listing.groups[0].internal).toBe(true);
    expect(listing.groups[0].state).toBe("Empty");
  });

  test("measures lag best effort per group", async () => {
    const { kafka } = provider();
    const lags = await kafka.measureGroupLag(["g-1", "missing", "g-1"]);
    expect(lags["g-1"]).toEqual({ totalLag: 8, lagError: null, topics: 1 });
    expect(lags.missing.lagError).toContain("no committed offsets");
    expect(await kafka.measureGroupLag([])).toEqual({});
  });

  test("describes a group with its members, refuses a Dead one with no offsets", async () => {
    const state = fakeWireState({
      described: new Map([
        [
          "g-1",
          {
            state: "Stable",
            protocolType: "consumer",
            protocol: "range",
            members: new Map([["m-1", { clientId: "consumer-1", clientHost: "/10.0.0.1" }]]),
          },
        ],
      ]),
    });
    const detail = await new KafkaProvider(config, { wire: fakeWire(state).wire }).describeConsumerGroup("g-1");
    expect(detail.groupId).toBe("g-1");
    expect(detail.members).toEqual([
      { memberId: "m-1", clientId: "consumer-1", clientHost: "/10.0.0.1", assignments: [] },
    ]);
    expect(detail.offsets).toHaveLength(1);
    const gone = fakeWireState({ described: new Map(), committed: [] });
    await expect(
      new KafkaProvider(config, { wire: fakeWire(gone).wire }).describeConsumerGroup("gone"),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("resets offsets for each mode and refuses a live group", async () => {
    const { kafka } = provider();
    for (const reset of [
      { mode: "earliest" },
      { mode: "latest" },
      { mode: "offset", offset: "5" },
      { mode: "timestamp", timestamp: 1700000000000 },
    ] as const) {
      const rows = await kafka.resetConsumerGroupOffsets({ groupId: "g-1", topic: "orders", reset });
      expect(rows).toHaveLength(2);
      expect(rows[0].committedOffset).toBeDefined();
    }
    const live = fakeWireState({
      described: new Map([
        [
          "g-1",
          {
            state: "Stable",
            protocolType: "consumer",
            protocol: "range",
            members: new Map([["m", { clientId: "c", clientHost: "h" }]]),
          },
        ],
      ]),
    });
    await expect(new KafkaProvider(config, { wire: fakeWire(live).wire }).deleteConsumerGroup("g-1")).rejects.toThrow(
      ResourceConflictError,
    );
  });

  test("deletes an Empty group", async () => {
    const state = fakeWireState();
    const { kafka } = provider(state);
    await kafka.deleteConsumerGroup("g-1");
    expect(state.deletedGroups).toHaveLength(1);
  });
});

describe("KafkaProvider — helpers", () => {
  test("the reset grammar is recognized", () => {
    expect(isKafkaOffsetReset({ mode: "earliest" })).toBe(true);
    expect(isKafkaOffsetReset({ mode: "latest" })).toBe(true);
    expect(isKafkaOffsetReset({ mode: "offset" })).toBe(true);
    expect(isKafkaOffsetReset({ mode: "timestamp" })).toBe(true);
    expect(isKafkaOffsetReset({ mode: "other" })).toBe(false);
    expect(isKafkaOffsetReset(null)).toBe(false);
  });

  test("an unknown broker failure is a connection error with the broker's sentence", async () => {
    const state = fakeWireState({ fail: "listTopics" });
    await expect(new KafkaProvider(config, { wire: fakeWire(state).wire }).listTopicSummaries()).rejects.toThrow(
      ResourceConnectionError,
    );
  });
});
