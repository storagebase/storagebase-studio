import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import {
  ResourceConfigError,
  ResourceConnectionError,
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
  value: string;
  timestamp?: string;
}

const store: Record<string, StoredMessage[][]> = {};

const sentBatches: Array<{ topic: string; messages: Array<Record<string, unknown>> }> = [];

class FakeAdmin {
  async connect() {}
  async disconnect() {}
  private refused() {
    const brokers = (FakeKafka.lastConfig as { brokers: string[] }).brokers;
    return brokers.some((broker) => broker === "localhost:1");
  }
  async listTopics() {
    if (this.refused()) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    return [...Object.keys(store), "__consumer_offsets"];
  }
  async fetchTopicOffsets(topic: string) {
    const partitions = store[topic];
    if (!partitions) {
      const error = new Error(`This server does not host topic ${topic}`) as Error & { type: string };
      error.type = "UNKNOWN_TOPIC_OR_PARTITION";
      throw error;
    }
    return partitions.map((messages, partition) => ({ partition, high: String(messages.length), low: "0" }));
  }
}

class FakeConsumer {
  static lastGroupId = "";
  constructor(options: { groupId: string }) {
    FakeConsumer.lastGroupId = options.groupId;
  }
  async connect() {}
  async disconnect() {}
  async subscribe() {}
  async stop() {}
  async run(handlers: {
    eachMessage: (payload: {
      topic: string;
      partition: number;
      message: { offset: string; key: Buffer | null; value: Buffer | null; timestamp: string };
    }) => Promise<void>;
  }) {
    // Delivery over time, like the real client: resolve once started.
    const topics = Object.keys(store);
    void (async () => {
      for (const topic of topics) {
        const partitions = store[topic];
        for (let partition = 0; partition < partitions.length; partition += 1) {
          for (let offset = 0; offset < partitions[partition].length; offset += 1) {
            const stored = partitions[partition][offset];
            await handlers.eachMessage({
              topic,
              partition,
              message: {
                offset: String(offset),
                key: stored.key === null ? null : Buffer.from(stored.key),
                value: Buffer.from(stored.value),
                timestamp: stored.timestamp ?? "1700000000000",
              },
            });
          }
        }
      }
    })();
  }
}

class FakeProducer {
  async connect() {}
  async disconnect() {}
  async send(batch: {
    topic: string;
    messages: Array<{ value: string; key?: string; headers?: Record<string, Buffer> }>;
  }) {
    sentBatches.push(batch as never);
    const partitions = store[batch.topic] ?? [[], [], []];
    for (const message of batch.messages) {
      partitions[0].push({ key: message.key ?? null, value: message.value });
    }
    store[batch.topic] = partitions;
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

mock.module("kafkajs", () => ({ Kafka: FakeKafka }));

// Importing the module self-registers the kafka loader, like production.
const { KafkaProvider } = await import("@/lib/resources/providers/messaging/kafka");

const connection: ResourceConnection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker1:9092,broker2:9092",
};

function seed() {
  for (const key of Object.keys(store)) delete store[key];
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

  test("capabilities declare browse and publish but never purge", () => {
    const provider = new KafkaProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "messaging", defaultPort: 9092 });
    expect(provider.getCapabilities().operations).toEqual(["tree", "message.browse", "message.publish"]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Topics", itemNoun: "Messages" });
  });
});
