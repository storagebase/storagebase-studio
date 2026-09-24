import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import {
  ResourceConfigError,
  ResourceConflictError,
  ResourceConnectionError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
} from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * Kafka provider tests. kafkajs is doubled with mock.module; the fake honors
 * the client's real contract points the provider depends on:
 * - `run()` resolves once fetching STARTS (delivery lands in the handler over
 *   time) — the provider's wait loop, not the `await run`, is what bounds the
 *   peek. A fake whose run() blocks until stop would prove nothing about the
 *   production shape.
 * - `fetchTopicOffsets` reports per-partition high/low; the provider derives
 *   the total and the truncation flag from it.
 * - Topics are seeded with messages across two partitions.
 */

interface StoredMessage {
  key: string | null;
  value: string | Buffer;
  timestamp?: string;
  headers?: Record<string, Buffer | string | Array<Buffer | string> | undefined>;
}

const store: Record<string, StoredMessage[][]> = {};

/** Per-topic log-start offsets (retention); absent means 0. */
const lows: Record<string, number[]> = {};

const sentBatches: Array<{ topic: string; messages: Array<Record<string, unknown>> }> = [];

interface FakeGroup {
  state: string;
  protocolType: string;
  protocol: string;
  members: Array<{ memberId: string; clientId: string; clientHost: string; memberAssignment: Buffer }>;
  offsets: Record<string, Record<number, string>>;
}

const groups: Record<string, FakeGroup> = {};

interface FakeConfig {
  configName: string;
  configValue: string;
  isDefault: boolean;
  configSource: number;
  isSensitive: boolean;
  readOnly: boolean;
}

const configs: Record<string, FakeConfig[]> = {};

/** Calls the fake admin recorded, by method, for write assertions. */
const adminCalls: Record<string, unknown[]> = {};

/** Per-method failures to inject: the value is thrown by that admin method. */
const adminFailures: Record<string, unknown> = {};

/**
 * Per-topic offset-read failures: the value is thrown by fetchTopicOffsets for
 * that topic only — how one broken topic among many is reproduced.
 */
const offsetFailures: Record<string, unknown> = {};

/** Per-topic leader overrides for the metadata answer (-1: leaderless). */
const leaders: Record<string, number> = {};

/** What createTopics answers (kafkajs: false when every topic already existed). */
let createTopicsAnswer = true;

function record(method: string, args: unknown) {
  (adminCalls[method] ??= []).push(args);
  if (method in adminFailures) throw adminFailures[method];
}

class FakeAdmin {
  async connect() {}
  async disconnect() {}
  private refused() {
    const brokers = (FakeKafka.lastConfig as { brokers: string[] }).brokers;
    return brokers.some((broker) => broker === "localhost:1");
  }
  async listTopics() {
    if (this.refused()) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    record("listTopics", null);
    return [...Object.keys(store), "__consumer_offsets"];
  }
  async fetchTopicOffsets(topic: string) {
    record("fetchTopicOffsets", topic);
    if (topic in offsetFailures) throw offsetFailures[topic];
    const partitions = store[topic];
    if (!partitions) {
      if (topic === "__consumer_offsets") return [{ partition: 0, high: "0", low: "0" }];
      const error = new Error(`This server does not host topic ${topic}`) as Error & { type: string };
      error.type = "UNKNOWN_TOPIC_OR_PARTITION";
      throw error;
    }
    return partitions.map((messages, partition) => ({
      partition,
      high: String(messages.length),
      low: String(lows[topic]?.[partition] ?? 0),
    }));
  }
  async fetchTopicOffsetsByTimestamp(topic: string, timestamp: number) {
    record("fetchTopicOffsetsByTimestamp", { topic, timestamp });
    return store[topic].map((messages, partition) => {
      const index = messages.findIndex((message) => Number(message.timestamp ?? "1700000000000") >= timestamp);
      return { partition, offset: index === -1 ? "-1" : String(index) };
    });
  }
  async fetchTopicMetadata(options?: { topics: string[] }) {
    record("fetchTopicMetadata", options ?? null);
    const names = options?.topics ?? [...Object.keys(store), "__consumer_offsets"];
    return {
      topics: names.map((name) => ({
        name,
        partitions: (store[name] ?? [[]]).map((_, partitionId) => ({
          partitionErrorCode: 0,
          partitionId,
          leader: leaders[name] ?? 1,
          replicas: name === "__consumer_offsets" ? [1] : [1, 2],
          // Partition 1 of a multi-partition topic is under-replicated.
          isr: partitionId === 1 ? [1] : name === "__consumer_offsets" ? [1] : [1, 2],
          ...(partitionId === 0 ? { offlineReplicas: [] } : {}),
        })),
      })),
    };
  }
  async describeCluster() {
    record("describeCluster", null);
    return {
      clusterId: "cluster-abc",
      controller: 2,
      brokers: [
        { nodeId: 2, host: "broker2", port: 9092 },
        { nodeId: 1, host: "broker1", port: 9092 },
      ],
    };
  }
  async describeConfigs(options: { resources: Array<{ type: number; name: string }> }) {
    record("describeConfigs", options);
    return {
      throttleTime: 0,
      resources: options.resources.map((resource) => ({
        resourceName: resource.name,
        resourceType: resource.type,
        errorCode: 0,
        errorMessage: "",
        configEntries: configs[resource.name] ?? [],
      })),
    };
  }
  async alterConfigs(options: unknown) {
    record("alterConfigs", options);
  }
  async createTopics(options: { topics: Array<{ topic: string; numPartitions: number }> }) {
    record("createTopics", options);
    return createTopicsAnswer;
  }
  async deleteTopics(options: unknown) {
    record("deleteTopics", options);
  }
  async createPartitions(options: unknown) {
    record("createPartitions", options);
  }
  async listGroups() {
    record("listGroups", null);
    return { groups: Object.keys(groups).map((groupId) => ({ groupId, protocolType: groups[groupId].protocolType })) };
  }
  async describeGroups(ids: string[]) {
    record("describeGroups", ids);
    return {
      groups: ids.map((groupId) => {
        const group = groups[groupId];
        return group
          ? {
              groupId,
              state: group.state,
              protocolType: group.protocolType,
              protocol: group.protocol,
              members: group.members,
            }
          : { groupId, state: "Dead", protocolType: "", protocol: "", members: [] };
      }),
    };
  }
  async fetchOffsets(options: { groupId: string }) {
    record("fetchOffsets", options);
    const group = groups[options.groupId];
    if (!group) return [];
    return Object.entries(group.offsets).map(([topic, partitions]) => ({
      topic,
      partitions: Object.entries(partitions).map(([partition, offset]) => ({
        partition: Number(partition),
        offset,
        metadata: null,
      })),
    }));
  }
  async setOffsets(options: unknown) {
    record("setOffsets", options);
  }
  async deleteGroups(ids: string[]) {
    record("deleteGroups", ids);
    return ids.map((groupId) => ({ groupId, errorCode: 0 }));
  }
}

class FakeConsumer {
  static lastGroupId = "";
  static seeks: Array<{ topic: string; partition: number; offset: string }> = [];
  /** When set, delivery never happens: the consumer joins and fetches nothing (a sick broker). */
  static silent = false;
  /** When set, `connect` throws this. */
  static connectFailure: unknown = null;
  private subscribed: { topic: string; fromBeginning: boolean } | null = null;
  private seekTo = new Map<number, number>();
  private stopped = false;
  constructor(options: { groupId: string }) {
    FakeConsumer.lastGroupId = options.groupId;
  }
  async connect() {
    if (FakeConsumer.connectFailure !== null) throw FakeConsumer.connectFailure;
  }
  async disconnect() {}
  async subscribe(options: { topic: string; fromBeginning: boolean }) {
    this.subscribed = options;
  }
  async stop() {
    this.stopped = true;
  }
  seek(entry: { topic: string; partition: number; offset: string }) {
    FakeConsumer.seeks.push(entry);
    this.seekTo.set(entry.partition, Number(entry.offset));
  }
  async run(handlers: {
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: {
        offset: string;
        key: Buffer | null;
        value: Buffer | null;
        timestamp: string;
        headers?: Record<string, unknown>;
      };
    }) => Promise<void>;
  }) {
    // Delivery over time, like the real client: resolve once started. Seeks
    // issued right after run() land before the first fetch, as in kafkajs.
    const subscribed = this.subscribed as { topic: string; fromBeginning: boolean };
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (FakeConsumer.silent) return;
      const topic = subscribed.topic;
      const partitions = store[topic];
      for (let partition = 0; partition < partitions.length; partition += 1) {
        const first =
          this.seekTo.get(partition) ??
          (subscribed.fromBeginning ? (lows[topic]?.[partition] ?? 0) : partitions[partition].length);
        for (let offset = first; offset < partitions[partition].length; offset += 1) {
          if (this.stopped) return;
          const stored = partitions[partition][offset];
          await handlers.eachMessage({
            topic,
            partition,
            message: {
              offset: String(offset),
              key: stored.key === null ? null : Buffer.from(stored.key),
              value: Buffer.from(stored.value),
              timestamp: stored.timestamp ?? "1700000000000",
              headers: stored.headers,
            },
          });
        }
      }
    })();
  }
}

class FakeProducer {
  static nextOffsetField: "baseOffset" | "offset" | "none" = "baseOffset";
  async connect() {}
  async disconnect() {}
  async send(batch: {
    topic: string;
    messages: Array<{ value: string; key?: string; partition?: number; headers?: Record<string, Buffer | string> }>;
  }) {
    sentBatches.push(batch as never);
    const partitions = store[batch.topic] ?? [[], [], []];
    let offset = 0;
    let target = 0;
    for (const message of batch.messages) {
      target = message.partition ?? 0;
      offset = partitions[target].length;
      partitions[target].push({ key: message.key ?? null, value: message.value });
    }
    store[batch.topic] = partitions;
    const field = FakeProducer.nextOffsetField;
    return [
      {
        topicName: batch.topic,
        partition: target,
        errorCode: 0,
        ...(field === "none" ? {} : { [field]: String(offset) }),
      },
    ];
  }
}

class FakeKafka {
  static lastConfig: unknown = null;
  constructor(config: unknown) {
    FakeKafka.lastConfig = config;
  }
  admin() {
    return new FakeAdmin();
  }
  consumer(options: { groupId: string }) {
    return new FakeConsumer(options);
  }
  producer() {
    return new FakeProducer();
  }
}

/** The fake assignment codec: JSON in a buffer; an empty buffer decodes to null, garbage throws. */
const AssignerProtocol = {
  MemberAssignment: {
    decode(buffer: Buffer) {
      if (buffer.length === 0) return null;
      return JSON.parse(buffer.toString()) as { assignment: Record<string, number[]> };
    },
  },
};

mock.module("kafkajs", () => ({ Kafka: FakeKafka, AssignerProtocol }));

// Importing the module self-registers the kafka loader, like production.
const {
  KafkaProvider,
  allocateReadQuotas,
  KAFKA_PEEK_GROUP_PREFIX,
  KAFKA_READ_BYTE_BUDGET,
  KAFKA_TOPIC_COUNT_LIMIT,
  KAFKA_GROUP_LAG_LIMIT,
  KAFKA_VALUE_MAX_BYTES,
} = await import("@/lib/resources/providers/messaging/kafka");

const connection: ResourceConnection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker1:9092,broker2:9092",
};

function seed() {
  for (const key of Object.keys(store)) delete store[key];
  for (const key of Object.keys(lows)) delete lows[key];
  for (const key of Object.keys(groups)) delete groups[key];
  for (const key of Object.keys(configs)) delete configs[key];
  for (const key of Object.keys(adminCalls)) delete adminCalls[key];
  for (const key of Object.keys(adminFailures)) delete adminFailures[key];
  for (const key of Object.keys(offsetFailures)) delete offsetFailures[key];
  for (const key of Object.keys(leaders)) delete leaders[key];
  createTopicsAnswer = true;
  FakeConsumer.seeks = [];
  FakeConsumer.silent = false;
  FakeConsumer.connectFailure = null;
  FakeProducer.nextOffsetField = "baseOffset";
  store["fixture-events"] = [
    [{ key: "k1", value: "hello-1" }],
    [
      { key: null, value: "hello-2" },
      { key: null, value: "x".repeat(300) },
    ],
  ];
}

describe("KafkaProvider", () => {
  beforeEach(() => {
    seed();
    sentBatches.length = 0;
    FakeKafka.lastConfig = null;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("kafka");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(KafkaProvider);
  });

  test("refuses a connection with no bootstrap endpoint", () => {
    expect(() => new KafkaProvider({ ...connection, endpoint: undefined })).toThrow(ResourceConfigError);
  });

  test("splits the bootstrap list and names the client after the connection", async () => {
    const provider = new KafkaProvider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    const config = FakeKafka.lastConfig as { brokers: string[]; clientId: string };
    expect(config.brokers).toEqual(["broker1:9092", "broker2:9092"]);
    expect(config.clientId).toContain("res-1");
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
  });

  test("health answers through the topic listing", async () => {
    const provider = new KafkaProvider(connection);
    expect((await provider.getHealth()).status).toBe("healthy");
  });

  test("a parent address answers empty — topics have no children", async () => {
    const provider = new KafkaProvider(connection);
    expect(await provider.listNodes("topic/fixture-events")).toEqual({ nodes: [], truncated: false });
  });

  test("lists topics without the internal ones", async () => {
    const provider = new KafkaProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.nodes.map((node) => node.name)).toEqual(["fixture-events"]);
    expect(page.nodes[0]).toMatchObject({ id: "topic/fixture-events", kind: "topic", hasChildren: false });
  });

  test("browses with previews, offsets and a computed truncation flag", async () => {
    const provider = new KafkaProvider(connection);
    const page = await provider.browseMessages("topic/fixture-events", 10);
    expect(page.truncated).toBe(false);
    expect(page.messages).toHaveLength(3);
    expect(page.messages[0]).toMatchObject({
      id: "topic/fixture-events/0/0",
      parentId: "topic/fixture-events",
      kind: "message",
      name: "k1",
    });
    expect(page.messages[0].meta).toMatchObject({ partition: 0, offset: "0", key: "k1", preview: "hello-1" });

    const capped = await provider.browseMessages("fixture-events", 2);
    expect(capped.messages).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  test("long bodies preview truncated at 200 chars", async () => {
    const provider = new KafkaProvider(connection);
    const page = await provider.browseMessages("fixture-events", 10);
    const long = page.messages.find((message) => (message.meta?.preview as string)?.startsWith("x"));
    expect(long?.meta?.preview).toHaveLength(200);
    expect(long?.meta?.previewTruncated).toBe(true);
  });

  test("a missing topic is a 404", async () => {
    const provider = new KafkaProvider(connection);
    const error = await provider.browseMessages("no-topic", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("publishes with key and headers", async () => {
    const provider = new KafkaProvider(connection);
    await provider.publishMessage("fixture-events", "hello-new", { key: "k9", trace: "abc" });
    expect(sentBatches).toHaveLength(1);
    expect(sentBatches[0].topic).toBe("fixture-events");
    const message = sentBatches[0].messages[0] as { value: string; key: string; headers: Record<string, Buffer> };
    expect(message.value).toBe("hello-new");
    expect(message.key).toBe("k9");
    expect(message.headers.trace.toString()).toBe("abc");
  });

  test("purge is refused with the honest sentence", async () => {
    const provider = new KafkaProvider(connection);
    const error = await provider.purgeQueue("fixture-events").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceOperationUnsupportedError);
    expect((error as Error).message).toContain("no purge");
  });

  test("a refusing broker surfaces as a connection error", async () => {
    const provider = new KafkaProvider({ ...connection, endpoint: "localhost:1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("capabilities declare browse, publish and the workbench set but never purge", () => {
    const provider = new KafkaProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "messaging", defaultPort: 9092 });
    expect(provider.getCapabilities().operations).toEqual([
      "tree",
      "message.browse",
      "message.publish",
      "kafka.inspect",
      "kafka.topic.write",
      "kafka.produce",
      "kafka.group.write",
    ]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Topics", itemNoun: "Messages" });
  });
});

function protocolError(type: string, message = type) {
  const error = new Error(message) as Error & { type: string };
  error.type = type;
  return error;
}

function assignment(topics: Record<string, number[]>) {
  return Buffer.from(JSON.stringify({ assignment: topics }));
}

describe("KafkaProvider workbench", () => {
  beforeEach(() => {
    seed();
    sentBatches.length = 0;
  });

  describe("read quota allocation", () => {
    test("water-fills the limit across partitions and never exceeds it", () => {
      expect(allocateReadQuotas([10, 10], 10)).toEqual([5, 5]);
      // What a short partition cannot use flows to the others.
      expect(allocateReadQuotas([1, 100, 0], 10)).toEqual([1, 9, 0]);
      expect(allocateReadQuotas([2, 2], 10)).toEqual([2, 2]);
      expect(allocateReadQuotas([5, 5, 5], 2)).toEqual([1, 1, 0]);
      expect(allocateReadQuotas([], 10)).toEqual([]);
    });
  });

  test("describes the cluster with the controller flagged, brokers in id order", async () => {
    const provider = new KafkaProvider(connection);
    const cluster = await provider.describeCluster();
    expect(cluster.clusterId).toBe("cluster-abc");
    expect(cluster.controllerId).toBe(2);
    expect(cluster.brokers).toEqual([
      { nodeId: 1, host: "broker1", port: 9092, rack: null, isController: false },
      { nodeId: 2, host: "broker2", port: 9092, rack: null, isController: true },
    ]);
  });

  test("lists topic summaries with internals flagged, replication and message counts", async () => {
    const provider = new KafkaProvider(connection);
    const listing = await provider.listTopicSummaries();
    expect(listing.countsTruncated).toBe(false);
    expect(listing.topics.map((topic) => topic.name)).toEqual(["__consumer_offsets", "fixture-events"]);
    expect(listing.topics[0]).toMatchObject({ internal: true, partitions: 1, replicationFactor: 1 });
    expect(listing.topics[1]).toEqual({
      name: "fixture-events",
      internal: false,
      partitions: 2,
      replicationFactor: 2,
      underReplicatedPartitions: 1,
      messageCount: 3,
      countError: null,
    });
  });

  test("message counts stop at the count bound and say so", async () => {
    for (let index = 0; index < KAFKA_TOPIC_COUNT_LIMIT; index += 1) {
      store[`t-${String(index).padStart(4, "0")}`] = [[]];
    }
    const provider = new KafkaProvider(connection);
    const listing = await provider.listTopicSummaries();
    expect(listing.countsTruncated).toBe(true);
    expect(listing.topics.filter((topic) => topic.messageCount === null)).toHaveLength(2);
  });

  test("describes one topic: partitions with offsets, configs by name with sources", async () => {
    lows["fixture-events"] = [0, 1];
    configs["fixture-events"] = [
      {
        configName: "retention.ms",
        configValue: "1000",
        isDefault: false,
        configSource: 1,
        isSensitive: false,
        readOnly: false,
      },
      {
        configName: "cleanup.policy",
        configValue: "delete",
        isDefault: true,
        configSource: 5,
        isSensitive: false,
        readOnly: false,
      },
      {
        configName: "secret.thing",
        configValue: "hidden",
        isDefault: false,
        configSource: 99,
        isSensitive: true,
        readOnly: true,
      },
    ];
    const provider = new KafkaProvider(connection);
    const detail = await provider.describeTopic("fixture-events");
    expect(detail.name).toBe("fixture-events");
    expect(detail.internal).toBe(false);
    expect(detail.partitions).toEqual([
      {
        partition: 0,
        leader: 1,
        replicas: [1, 2],
        isr: [1, 2],
        offlineReplicas: [],
        earliestOffset: "0",
        latestOffset: "1",
      },
      {
        partition: 1,
        leader: 1,
        replicas: [1, 2],
        isr: [1],
        offlineReplicas: [],
        earliestOffset: "1",
        latestOffset: "2",
      },
    ]);
    expect(detail.configs.map((entry) => entry.name)).toEqual(["cleanup.policy", "retention.ms", "secret.thing"]);
    expect(detail.configs[1]).toEqual({
      name: "retention.ms",
      value: "1000",
      source: "TOPIC_CONFIG",
      isDefault: false,
      readOnly: false,
      isSensitive: false,
    });
    // Sensitive values are never echoed; an unknown source reads as UNKNOWN.
    expect(detail.configs[2]).toMatchObject({ value: null, source: "UNKNOWN", isSensitive: true });
  });

  test("describing a topic tolerates empty metadata and missing watermarks", async () => {
    const provider = new KafkaProvider(connection);
    const original = FakeAdmin.prototype.fetchTopicMetadata;
    const originalOffsets = FakeAdmin.prototype.fetchTopicOffsets;
    FakeAdmin.prototype.fetchTopicMetadata = async () => ({ topics: [] });
    try {
      const empty = await provider.describeTopic("fixture-events");
      expect(empty.partitions).toEqual([]);
      // No partition metadata: the offsets are not asked for at all.
      expect(empty.offsetsError).toContain("no partition metadata");
      FakeAdmin.prototype.fetchTopicMetadata = original;
      FakeAdmin.prototype.fetchTopicOffsets = async () => [];
      const detail = await provider.describeTopic("fixture-events");
      expect(detail.partitions[0]).toMatchObject({ earliestOffset: null, latestOffset: null });
      expect(detail.offsetsError).toBeNull();
    } finally {
      FakeAdmin.prototype.fetchTopicMetadata = original;
      FakeAdmin.prototype.fetchTopicOffsets = originalOffsets;
    }
  });

  test("describing an absent topic is a 404, and an empty config answer is no configs", async () => {
    const provider = new KafkaProvider(connection);
    expect(await provider.describeTopic("nope").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
    const original = FakeAdmin.prototype.describeConfigs;
    FakeAdmin.prototype.describeConfigs = async () => ({ throttleTime: 0, resources: [] });
    try {
      expect((await provider.describeTopic("fixture-events")).configs).toEqual([]);
    } finally {
      FakeAdmin.prototype.describeConfigs = original;
    }
  });

  test("creates a topic with its configs, and an existing name is a conflict", async () => {
    const provider = new KafkaProvider(connection);
    await provider.createTopic({
      name: "new-topic",
      partitions: 3,
      replicationFactor: 1,
      configs: { "retention.ms": "5" },
    });
    expect(adminCalls.createTopics?.[0]).toEqual({
      waitForLeaders: true,
      topics: [
        {
          topic: "new-topic",
          numPartitions: 3,
          replicationFactor: 1,
          configEntries: [{ name: "retention.ms", value: "5" }],
        },
      ],
    });
    await provider.createTopic({ name: "bare", partitions: 1, replicationFactor: 1 });
    expect(
      ((adminCalls.createTopics ?? [])[1] as { topics: Array<{ configEntries: unknown[] }> }).topics[0].configEntries,
    ).toEqual([]);

    createTopicsAnswer = false;
    expect(
      await provider
        .createTopic({ name: "fixture-events", partitions: 1, replicationFactor: 1 })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(ResourceConflictError);
  });

  test("broker refusals map onto 400 / 409 / 404 with the broker's sentence", async () => {
    const provider = new KafkaProvider(connection);
    adminFailures.createTopics = {
      errors: [protocolError("INVALID_REPLICATION_FACTOR", "Replication factor: 3 larger than available brokers: 1")],
    };
    const invalid = await provider
      .createTopic({ name: "x", partitions: 1, replicationFactor: 3 })
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ResourceInvalidRequestError);
    expect((invalid as Error).message).toContain("larger than available brokers");

    adminFailures.createTopics = protocolError("TOPIC_ALREADY_EXISTS");
    expect(
      await provider.createTopic({ name: "x", partitions: 1, replicationFactor: 1 }).catch((e: unknown) => e),
    ).toBeInstanceOf(ResourceConflictError);

    adminFailures.createTopics = protocolError("UNKNOWN_TOPIC_OR_PARTITION");
    expect(
      await provider.createTopic({ name: "x", partitions: 1, replicationFactor: 1 }).catch((e: unknown) => e),
    ).toBeInstanceOf(ResourceNotFoundError);

    // Unmapped protocol types, shapeless objects and bare strings are the connection's.
    for (const failure of [protocolError("NETWORK_EXCEPTION"), { errors: [] }, "socket hang up", null]) {
      adminFailures.createTopics = failure;
      expect(
        await provider.createTopic({ name: "x", partitions: 1, replicationFactor: 1 }).catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceConnectionError);
    }
  });

  test("deletes an existing topic and refuses an absent one", async () => {
    const provider = new KafkaProvider(connection);
    await provider.deleteTopic("fixture-events");
    expect(adminCalls.deleteTopics).toEqual([{ topics: ["fixture-events"] }]);
    expect(await provider.deleteTopic("nope").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
  });

  test("adds partitions only upward", async () => {
    const provider = new KafkaProvider(connection);
    await provider.addPartitions("fixture-events", 4);
    expect(adminCalls.createPartitions).toEqual([{ topicPartitions: [{ topic: "fixture-events", count: 4 }] }]);
    const shrink = await provider.addPartitions("fixture-events", 2).catch((e: unknown) => e);
    expect(shrink).toBeInstanceOf(ResourceConflictError);
    expect((shrink as Error).message).toContain("already has 2 partitions");

    const original = FakeAdmin.prototype.fetchTopicMetadata;
    FakeAdmin.prototype.fetchTopicMetadata = async () => ({ topics: [] });
    try {
      await provider.addPartitions("fixture-events", 1);
      expect(adminCalls.createPartitions).toHaveLength(2);
    } finally {
      FakeAdmin.prototype.fetchTopicMetadata = original;
    }
  });

  test("config edits merge into the existing overrides — never replace them", async () => {
    configs["fixture-events"] = [
      {
        configName: "retention.ms",
        configValue: "1000",
        isDefault: false,
        configSource: 1,
        isSensitive: false,
        readOnly: false,
      },
      {
        configName: "max.message.bytes",
        configValue: "2048",
        isDefault: false,
        configSource: 1,
        isSensitive: false,
        readOnly: false,
      },
      {
        configName: "cleanup.policy",
        configValue: "delete",
        isDefault: true,
        configSource: 5,
        isSensitive: false,
        readOnly: false,
      },
    ];
    const provider = new KafkaProvider(connection);
    await provider.alterTopicConfigs("fixture-events", {
      "retention.ms": "5000",
      "max.message.bytes": null,
      "segment.ms": "10",
    });
    expect(adminCalls.alterConfigs).toEqual([
      {
        validateOnly: false,
        resources: [
          {
            type: 2,
            name: "fixture-events",
            configEntries: [
              { name: "retention.ms", value: "5000" },
              { name: "segment.ms", value: "10" },
            ],
          },
        ],
      },
    ]);
  });

  test("a sensitive override blocks config edits rather than being wiped", async () => {
    configs["fixture-events"] = [
      {
        configName: "ssl.thing",
        configValue: "",
        isDefault: false,
        configSource: 1,
        isSensitive: true,
        readOnly: false,
      },
    ];
    const provider = new KafkaProvider(connection);
    const error = await provider.alterTopicConfigs("fixture-events", { "retention.ms": "1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConflictError);
    expect(adminCalls.alterConfigs).toBeUndefined();
  });

  describe("readMessages", () => {
    test("earliest reads oldest first with full bodies, keys and headers", async () => {
      store["fixture-events"][0][0].headers = {
        trace: Buffer.from("abc"),
        multi: ["a", Buffer.from("b")],
        gone: undefined,
      };
      store["fixture-events"][0][0].timestamp = "1700000000005";
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 10 });
      expect(page.truncated).toBe(false);
      expect(page.messages.map((message) => `${message.partition}/${message.offset}`)).toEqual(["1/0", "1/1", "0/0"]);
      const first = page.messages.find((message) => message.key === "k1");
      expect(first).toEqual({
        partition: 0,
        offset: "0",
        timestamp: "1700000000005",
        key: "k1",
        value: "hello-1",
        keyEncoding: "utf8",
        valueEncoding: "utf8",
        valueTruncated: false,
        valueBytes: 7,
        headers: { trace: "abc", multi: "a, b" },
      });
      // Bodies are whole, not a 200-char preview.
      expect(page.messages[1].value).toHaveLength(300);
      expect(page.messages[1].key).toBeNull();
      expect(FakeConsumer.lastGroupId.startsWith(KAFKA_PEEK_GROUP_PREFIX)).toBe(true);
      // The throwaway group is cleaned up after the read.
      expect(adminCalls.deleteGroups).toEqual([[FakeConsumer.lastGroupId]]);
    });

    test("latest tails the newest messages, newest first, split across partitions", async () => {
      store["fixture-events"][1][1].timestamp = "1700000000009";
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", { seek: { mode: "latest" }, limit: 2 });
      expect(page.messages.map((message) => `${message.partition}/${message.offset}`)).toEqual(["1/1", "0/0"]);
      expect(page.truncated).toBe(true);
    });

    test("one partition from a specific offset, clamped to the log", async () => {
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", {
        partition: 1,
        seek: { mode: "offset", offset: "1" },
        limit: 10,
      });
      expect(page.messages.map((message) => message.offset)).toEqual(["1"]);
      expect(FakeConsumer.seeks).toEqual([{ topic: "fixture-events", partition: 1, offset: "1" }]);

      const below = await provider.readMessages("fixture-events", {
        partition: 1,
        seek: { mode: "offset", offset: "0" },
        limit: 1,
      });
      expect(below.messages.map((message) => message.offset)).toEqual(["0"]);
      expect(below.truncated).toBe(true);

      // Past the end reads nothing and starts no consumer.
      FakeConsumer.lastGroupId = "";
      const past = await provider.readMessages("fixture-events", {
        partition: 1,
        seek: { mode: "offset", offset: "99" },
        limit: 5,
      });
      expect(past).toEqual({ messages: [], truncated: false });
      expect(FakeConsumer.lastGroupId).toBe("");
    });

    test("timestamp seeks per partition; partitions with nothing after it read nothing", async () => {
      store["fixture-events"][0][0].timestamp = "1600000000000";
      store["fixture-events"][1][0].timestamp = "1600000000000";
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", {
        seek: { mode: "timestamp", timestamp: 1650000000000 },
        limit: 10,
      });
      expect(page.messages.map((message) => `${message.partition}/${message.offset}`)).toEqual(["1/1"]);

      const original = FakeAdmin.prototype.fetchTopicOffsetsByTimestamp;
      FakeAdmin.prototype.fetchTopicOffsetsByTimestamp = async () => [];
      try {
        const none = await provider.readMessages("fixture-events", {
          seek: { mode: "timestamp", timestamp: 1 },
          limit: 10,
        });
        expect(none.messages).toEqual([]);
      } finally {
        FakeAdmin.prototype.fetchTopicOffsetsByTimestamp = original;
      }
    });

    test("binary bodies come back base64, oversize values are cut at the cap", async () => {
      store["fixture-events"] = [
        [
          { key: null, value: Buffer.from([0xff, 0xfe, 0x00]) },
          { key: null, value: "é".repeat(KAFKA_VALUE_MAX_BYTES) },
        ],
      ];
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 10 });
      expect(page.messages[0]).toMatchObject({
        valueEncoding: "base64",
        value: "//4A",
        valueTruncated: false,
        valueBytes: 3,
      });
      expect(page.messages[1]).toMatchObject({
        valueEncoding: "utf8",
        valueTruncated: true,
        valueBytes: KAFKA_VALUE_MAX_BYTES * 2,
      });
      // A character split by the cap is dropped, not rendered as garbage.
      expect(page.messages[1].value).toBe("é".repeat(KAFKA_VALUE_MAX_BYTES / 2));
    });

    test("the byte budget ends a read early with truncation set", async () => {
      const big = "x".repeat(KAFKA_VALUE_MAX_BYTES);
      const count = Math.ceil(KAFKA_READ_BYTE_BUDGET / KAFKA_VALUE_MAX_BYTES) + 5;
      store["fixture-events"] = [Array.from({ length: count }, () => ({ key: null, value: big }))];
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 200 });
      expect(page.messages).toHaveLength(KAFKA_READ_BYTE_BUDGET / KAFKA_VALUE_MAX_BYTES);
      expect(page.truncated).toBe(true);
    });

    test("an unknown partition or topic is a 404; a failing consumer is a connection error", async () => {
      const provider = new KafkaProvider(connection);
      expect(
        await provider
          .readMessages("fixture-events", { partition: 9, seek: { mode: "earliest" }, limit: 5 })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceNotFoundError);
      expect(
        await provider.readMessages("nope", { seek: { mode: "earliest" }, limit: 5 }).catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceNotFoundError);
      FakeConsumer.connectFailure = new Error("group coordinator not available");
      expect(
        await provider
          .readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 5 })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceConnectionError);
    });

    test("a failed peek-group cleanup never fails the read", async () => {
      adminFailures.deleteGroups = new Error("coordinator moved");
      const provider = new KafkaProvider(connection);
      const page = await provider.readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 10 });
      expect(page.messages).toHaveLength(3);
    });

    test(
      "a silent broker ends at the deadline with what arrived",
      async () => {
        FakeConsumer.silent = true;
        const provider = new KafkaProvider(connection);
        const originalNow = Date.now;
        let now = originalNow();
        // Move the clock past the deadline instead of waiting 15 seconds.
        Date.now = () => (now += 5_000);
        try {
          const page = await provider.readMessages("fixture-events", { seek: { mode: "earliest" }, limit: 10 });
          expect(page).toEqual({ messages: [], truncated: true });
        } finally {
          Date.now = originalNow;
        }
      },
      { timeout: 5_000 },
    );
  });

  test("produces with key, headers and partition, answering where it landed", async () => {
    const provider = new KafkaProvider(connection);
    const result = await provider.produceMessage("fixture-events", {
      key: "k2",
      value: "v",
      headers: { trace: "t" },
      partition: 1,
    });
    expect(result).toEqual({ partition: 1, offset: "2" });
    expect(sentBatches[0].messages[0]).toEqual({ value: "v", key: "k2", partition: 1, headers: { trace: "t" } });

    await provider.produceMessage("fixture-events", { value: "bare" });
    expect(sentBatches[1].messages[0]).toEqual({ value: "bare" });

    FakeProducer.nextOffsetField = "offset";
    expect((await provider.produceMessage("fixture-events", { value: "a" })).offset).toBe("2");
    FakeProducer.nextOffsetField = "none";
    expect((await provider.produceMessage("fixture-events", { value: "b" })).offset).toBe("-1");
  });

  test("producing to an absent topic is refused before any producer connects", async () => {
    const provider = new KafkaProvider(connection);
    expect(await provider.produceMessage("typo", { value: "x" }).catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(sentBatches).toHaveLength(0);
    const original = FakeProducer.prototype.send;
    FakeProducer.prototype.send = async () => {
      throw new Error("broker went away");
    };
    try {
      expect(await provider.produceMessage("fixture-events", { value: "x" }).catch((e: unknown) => e)).toBeInstanceOf(
        ResourceConnectionError,
      );
    } finally {
      FakeProducer.prototype.send = original;
    }
  });

  describe("consumer groups", () => {
    function seedGroups() {
      groups["billing"] = {
        state: "Stable",
        protocolType: "consumer",
        protocol: "range",
        members: [
          {
            memberId: "m-2",
            clientId: "c-2",
            clientHost: "/10.0.0.2",
            memberAssignment: assignment({ "fixture-events": [1, 0] }),
          },
          { memberId: "m-1", clientId: "c-1", clientHost: "/10.0.0.1", memberAssignment: Buffer.alloc(0) },
          { memberId: "m-3", clientId: "c-3", clientHost: "/10.0.0.3", memberAssignment: Buffer.from("not json") },
        ],
        offsets: { "fixture-events": { 0: "1", 1: "-1" }, other: { 0: "0" } },
      };
      groups["archiver"] = {
        state: "Empty",
        protocolType: "consumer",
        protocol: "",
        members: [],
        offsets: { "fixture-events": { 0: "0", 1: "0" } },
      };
      groups[`${KAFKA_PEEK_GROUP_PREFIX}x-1`] = {
        state: "Empty",
        protocolType: "consumer",
        protocol: "",
        members: [],
        offsets: {},
      };
      store.other = [
        [
          { key: null, value: "a" },
          { key: null, value: "b" },
        ],
        [],
      ];
    }

    test("lists groups with state, members and total lag; peek groups are flagged, not measured", async () => {
      seedGroups();
      const provider = new KafkaProvider(connection);
      const listing = await provider.listConsumerGroups();
      expect(listing.lagTruncated).toBe(false);
      expect(listing.groups).toEqual([
        {
          groupId: "archiver",
          state: "Empty",
          protocolType: "consumer",
          protocol: "",
          members: 0,
          totalLag: 3,
          lagError: null,
          internal: false,
        },
        {
          groupId: "billing",
          state: "Stable",
          protocolType: "consumer",
          protocol: "range",
          members: 3,
          totalLag: 2,
          lagError: null,
          internal: false,
        },
        {
          groupId: `${KAFKA_PEEK_GROUP_PREFIX}x-1`,
          state: "Empty",
          protocolType: "consumer",
          protocol: "",
          members: 0,
          totalLag: null,
          lagError: null,
          internal: true,
        },
      ]);
      // End offsets are read once per topic across all groups.
      expect((adminCalls.fetchTopicOffsets as string[]).filter((topic) => topic === "fixture-events")).toHaveLength(1);
    });

    test("an empty cluster lists no groups; lag stops at the bound; unknown descriptions default", async () => {
      const provider = new KafkaProvider(connection);
      expect(await provider.listConsumerGroups()).toEqual({ groups: [], lagTruncated: false });

      for (let index = 0; index <= KAFKA_GROUP_LAG_LIMIT; index += 1) {
        groups[`g-${String(index).padStart(3, "0")}`] = {
          state: "Empty",
          protocolType: "consumer",
          protocol: "",
          members: [],
          offsets: {},
        };
      }
      const original = FakeAdmin.prototype.describeGroups;
      FakeAdmin.prototype.describeGroups = async () => ({ groups: [] });
      try {
        const listing = await provider.listConsumerGroups();
        expect(listing.lagTruncated).toBe(true);
        expect(listing.groups.at(-1)).toMatchObject({
          totalLag: null,
          lagError: null,
          state: "Unknown",
          members: 0,
          protocol: "",
          protocolType: "",
        });
      } finally {
        FakeAdmin.prototype.describeGroups = original;
      }
    });

    test("describes a group: members with decoded assignments, per-partition lag", async () => {
      seedGroups();
      const provider = new KafkaProvider(connection);
      const detail = await provider.describeConsumerGroup("billing");
      expect(detail).toMatchObject({
        groupId: "billing",
        state: "Stable",
        protocolType: "consumer",
        protocol: "range",
      });
      expect(detail.members).toEqual([
        {
          memberId: "m-2",
          clientId: "c-2",
          clientHost: "/10.0.0.2",
          assignments: [{ topic: "fixture-events", partitions: [0, 1] }],
        },
        { memberId: "m-1", clientId: "c-1", clientHost: "/10.0.0.1", assignments: [] },
        { memberId: "m-3", clientId: "c-3", clientHost: "/10.0.0.3", assignments: [] },
      ]);
      expect(detail.offsets).toEqual([
        { topic: "fixture-events", partition: 0, committedOffset: "1", endOffset: "1", lag: 0, endOffsetError: null },
        {
          topic: "fixture-events",
          partition: 1,
          committedOffset: null,
          endOffset: "2",
          lag: null,
          endOffsetError: null,
        },
        { topic: "other", partition: 0, committedOffset: "0", endOffset: "2", lag: 2, endOffsetError: null },
      ]);
    });

    test("an unknown group is a 404; a partition missing from the end offsets reads as 0", async () => {
      const provider = new KafkaProvider(connection);
      expect(await provider.describeConsumerGroup("ghost").catch((e: unknown) => e)).toBeInstanceOf(
        ResourceNotFoundError,
      );
      const original = FakeAdmin.prototype.describeGroups;
      FakeAdmin.prototype.describeGroups = async () => ({ groups: [] });
      try {
        expect(await provider.describeConsumerGroup("ghost").catch((e: unknown) => e)).toBeInstanceOf(
          ResourceNotFoundError,
        );
      } finally {
        FakeAdmin.prototype.describeGroups = original;
      }
      groups.stale = {
        state: "Empty",
        protocolType: "consumer",
        protocol: "",
        members: [],
        offsets: { "fixture-events": { 7: "3" } },
      };
      const detail = await provider.describeConsumerGroup("stale");
      expect(detail.offsets[0]).toEqual({
        topic: "fixture-events",
        partition: 7,
        committedOffset: "3",
        endOffset: "0",
        lag: 0,
        endOffsetError: null,
      });
    });

    test("resets an Empty group to earliest, latest, a timestamp or an offset", async () => {
      seedGroups();
      lows["fixture-events"] = [0, 1];
      const provider = new KafkaProvider(connection);

      const earliest = await provider.resetConsumerGroupOffsets({
        groupId: "archiver",
        topic: "fixture-events",
        reset: { mode: "earliest" },
      });
      expect(earliest.map((row) => row.committedOffset)).toEqual(["0", "1"]);
      expect(adminCalls.setOffsets?.[0]).toEqual({
        groupId: "archiver",
        topic: "fixture-events",
        partitions: [
          { partition: 0, offset: "0" },
          { partition: 1, offset: "1" },
        ],
      });

      const latest = await provider.resetConsumerGroupOffsets({
        groupId: "archiver",
        topic: "fixture-events",
        reset: { mode: "latest" },
      });
      expect(latest).toEqual([
        { topic: "fixture-events", partition: 0, committedOffset: "1", endOffset: "1", lag: 0, endOffsetError: null },
        { topic: "fixture-events", partition: 1, committedOffset: "2", endOffset: "2", lag: 0, endOffsetError: null },
      ]);

      const offset = await provider.resetConsumerGroupOffsets({
        groupId: "archiver",
        topic: "fixture-events",
        reset: { mode: "offset", offset: "0" },
        partitions: [1],
      });
      // Clamped to the log start of partition 1.
      expect(offset).toEqual([
        { topic: "fixture-events", partition: 1, committedOffset: "1", endOffset: "2", lag: 1, endOffsetError: null },
      ]);

      const byTime = await provider.resetConsumerGroupOffsets({
        groupId: "archiver",
        topic: "fixture-events",
        reset: { mode: "timestamp", timestamp: 1 },
      });
      expect(byTime.map((row) => row.committedOffset)).toEqual(["0", "1"]);
    });

    test("resets are refused on a group with live members, on absent groups, topics and partitions", async () => {
      seedGroups();
      const provider = new KafkaProvider(connection);
      const live = await provider
        .resetConsumerGroupOffsets({ groupId: "billing", topic: "fixture-events", reset: { mode: "earliest" } })
        .catch((e: unknown) => e);
      expect(live).toBeInstanceOf(ResourceConflictError);
      expect((live as Error).message).toContain("while it is Stable with 3 active member(s)");
      expect(adminCalls.setOffsets).toBeUndefined();

      expect(
        await provider
          .resetConsumerGroupOffsets({ groupId: "ghost", topic: "fixture-events", reset: { mode: "earliest" } })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceNotFoundError);
      expect(
        await provider
          .resetConsumerGroupOffsets({ groupId: "archiver", topic: "nope", reset: { mode: "earliest" } })
          .catch((e: unknown) => e),
      ).toBeInstanceOf(ResourceNotFoundError);
      const partitions = await provider
        .resetConsumerGroupOffsets({
          groupId: "archiver",
          topic: "fixture-events",
          reset: { mode: "earliest" },
          partitions: [9],
        })
        .catch((e: unknown) => e);
      expect(partitions).toBeInstanceOf(ResourceNotFoundError);
      expect((partitions as Error).message).toContain("partitions 9");

      const original = FakeAdmin.prototype.describeGroups;
      FakeAdmin.prototype.describeGroups = async () => ({ groups: [] });
      try {
        expect(
          await provider
            .resetConsumerGroupOffsets({ groupId: "archiver", topic: "fixture-events", reset: { mode: "earliest" } })
            .catch((e: unknown) => e),
        ).toBeInstanceOf(ResourceNotFoundError);
      } finally {
        FakeAdmin.prototype.describeGroups = original;
      }
    });

    test("deletes an Empty group, refuses a live one, and maps a broker refusal", async () => {
      seedGroups();
      const provider = new KafkaProvider(connection);
      await provider.deleteConsumerGroup("archiver");
      expect(adminCalls.deleteGroups).toEqual([["archiver"]]);
      expect(await provider.deleteConsumerGroup("billing").catch((e: unknown) => e)).toBeInstanceOf(
        ResourceConflictError,
      );

      adminFailures.deleteGroups = {
        groups: [{ groupId: "archiver" }, { groupId: "archiver", error: protocolError("NON_EMPTY_GROUP") }],
      };
      expect(await provider.deleteConsumerGroup("archiver").catch((e: unknown) => e)).toBeInstanceOf(
        ResourceConflictError,
      );
    });
  });
});

/**
 * Regression: on a live cluster the topic listing failed as a whole with
 * kafkajs' own TypeError from inside its offset fetch, raised for ONE topic
 * whose ListOffsets response came back short. Offsets are best effort per
 * topic; only the listing and metadata calls may fail a read.
 */
describe("KafkaProvider offset reads are best effort per topic", () => {
  const shortResponse = () =>
    new TypeError("Cannot destructure property 'partitions' of 'high.pop(...)' as it is undefined.");

  beforeEach(() => {
    seed();
    store["topic-a"] = [[{ key: null, value: "a" }]];
    store["topic-broken"] = [[{ key: null, value: "b" }], []];
    store["topic-c"] = [
      [
        { key: null, value: "c1" },
        { key: null, value: "c2" },
      ],
    ];
    offsetFailures["topic-broken"] = shortResponse();
  });

  test("one unreadable topic answers null with its reason; every other topic is counted", async () => {
    const provider = new KafkaProvider(connection);
    const listing = await provider.listTopicSummaries();
    const byName = Object.fromEntries(listing.topics.map((topic) => [topic.name, topic]));
    expect(listing.topics).toHaveLength(5);
    expect(byName["topic-broken"]).toMatchObject({ partitions: 2, messageCount: null });
    expect(byName["topic-broken"].countError).toContain("Cannot destructure property 'partitions'");
    expect(byName["topic-a"]).toMatchObject({ messageCount: 1, countError: null });
    expect(byName["topic-c"]).toMatchObject({ messageCount: 2, countError: null });
    expect(byName["fixture-events"]).toMatchObject({ messageCount: 3, countError: null });
  });

  test("a leaderless topic is not asked for offsets at all", async () => {
    leaders["topic-c"] = -1;
    const provider = new KafkaProvider(connection);
    const listing = await provider.listTopicSummaries();
    const leaderless = listing.topics.find((topic) => topic.name === "topic-c");
    expect(leaderless).toMatchObject({ messageCount: null, countError: "partition 0 has no leader" });
    expect(adminCalls.fetchTopicOffsets).not.toContain("topic-c");
  });

  test("topic detail keeps partitions and configs when the offsets cannot be read", async () => {
    configs["topic-broken"] = [
      {
        configName: "retention.ms",
        configValue: "1",
        isDefault: false,
        configSource: 1,
        isSensitive: false,
        readOnly: false,
      },
    ];
    const provider = new KafkaProvider(connection);
    const detail = await provider.describeTopic("topic-broken");
    expect(detail.partitions).toHaveLength(2);
    expect(detail.partitions[0]).toMatchObject({ leader: 1, earliestOffset: null, latestOffset: null });
    expect(detail.offsetsError).toContain("Cannot destructure property 'partitions'");
    expect(detail.configs.map((entry) => entry.name)).toEqual(["retention.ms"]);
  });

  test("a group committed on an unreadable topic loses its lag, not the listing", async () => {
    groups["group-mixed"] = {
      state: "Empty",
      protocolType: "consumer",
      protocol: "",
      members: [],
      offsets: { "topic-a": { 0: "0" }, "topic-broken": { 0: "0" } },
    };
    groups["group-also-broken"] = {
      state: "Empty",
      protocolType: "consumer",
      protocol: "",
      members: [],
      offsets: { "topic-broken": { 1: "0" } },
    };
    groups["group-healthy"] = {
      state: "Empty",
      protocolType: "consumer",
      protocol: "",
      members: [],
      offsets: { "topic-c": { 0: "1" } },
    };
    const provider = new KafkaProvider(connection);
    const listing = await provider.listConsumerGroups();
    const byId = Object.fromEntries(listing.groups.map((group) => [group.groupId, group]));
    expect(byId["group-healthy"]).toMatchObject({ totalLag: 1, lagError: null });
    expect(byId["group-mixed"].totalLag).toBeNull();
    expect(byId["group-mixed"].lagError).toContain("topic-broken: Cannot destructure");
    expect(byId["group-also-broken"].totalLag).toBeNull();
    // The failure is cached like a success: two groups, one attempt.
    expect((adminCalls.fetchTopicOffsets as string[]).filter((topic) => topic === "topic-broken")).toHaveLength(1);
  });

  test("a group whose committed offsets cannot be fetched answers its reason, the listing still answers", async () => {
    groups["group-x"] = { state: "Empty", protocolType: "consumer", protocol: "", members: [], offsets: {} };
    groups["group-y"] = { state: "Empty", protocolType: "consumer", protocol: "", members: [], offsets: {} };
    const original = FakeAdmin.prototype.fetchOffsets;
    FakeAdmin.prototype.fetchOffsets = async function (options: { groupId: string }) {
      if (options.groupId === "group-x") throw shortResponse();
      return original.call(this, options);
    };
    try {
      const provider = new KafkaProvider(connection);
      const listing = await provider.listConsumerGroups();
      expect(listing.groups.find((group) => group.groupId === "group-x")).toMatchObject({ totalLag: null });
      expect(listing.groups.find((group) => group.groupId === "group-x")?.lagError).toContain("Cannot destructure");
      expect(listing.groups.find((group) => group.groupId === "group-y")).toMatchObject({
        totalLag: 0,
        lagError: null,
      });
    } finally {
      FakeAdmin.prototype.fetchOffsets = original;
    }
  });

  test("group detail answers the readable rows and marks the unreadable ones", async () => {
    groups["group-mixed"] = {
      state: "Empty",
      protocolType: "consumer",
      protocol: "",
      members: [],
      offsets: { "topic-a": { 0: "0" }, "topic-broken": { 0: "0" } },
    };
    const provider = new KafkaProvider(connection);
    const detail = await provider.describeConsumerGroup("group-mixed");
    expect(detail.offsets[0]).toEqual({
      topic: "topic-a",
      partition: 0,
      committedOffset: "0",
      endOffset: "1",
      lag: 1,
      endOffsetError: null,
    });
    expect(detail.offsets[1]).toMatchObject({
      topic: "topic-broken",
      committedOffset: "0",
      endOffset: null,
      lag: null,
    });
    expect(detail.offsets[1].endOffsetError).toContain("Cannot destructure");
  });
});
