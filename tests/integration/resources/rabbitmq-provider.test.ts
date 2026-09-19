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
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

/**
 * RabbitMQ provider tests. amqplib is doubled with mock.module and the
 * management HTTP API with a fetch double; every answer is shaped from a live
 * pass against the fixture stack (measured 2026-09-20):
 * - The tree lists user exchanges and queues; amq.* broker furniture and the
 *   nameless default exchange are filtered.
 * - Peek consumes with immediate requeue (nack requeue:true per message).
 * - A refused checkQueue closes the CHANNEL server-side (404 NOT-FOUND):
 *   the provider maps it to 404 without crashing on the channel 'error' event.
 */

interface StoredMessage {
  body: string;
  exchange: string;
  routingKey: string;
  redelivered: boolean;
}

const queues: Record<string, StoredMessage[]> = {};

const published: Array<{ exchange: string; routingKey: string; body: string; headers: Record<string, unknown> }> = [];
const purged: string[] = [];
const nacked: Array<{ requeue: boolean }> = [];

class FakeChannel {
  async checkQueue(name: string) {
    if (!(name in queues)) {
      const error = new Error(
        `Channel closed by server: 404 (NOT-FOUND) with message "NOT-FOUND - no queue '${name}' in vhost '/'"`,
      ) as Error & { code: number };
      error.code = 404;
      throw error;
    }
    return { queue: name, messageCount: queues[name].length, consumerCount: 0 };
  }
  async checkExchange(name: string) {
    if (name !== "fixture.events") {
      const error = new Error(
        `Channel closed by server: 404 (NOT-FOUND) with message "NOT-FOUND - no exchange '${name}' in vhost '/'"`,
      ) as Error & { code: number };
      error.code = 404;
      throw error;
    }
    return {};
  }
  async get(name: string, _options?: unknown) {
    const next = queues[name]?.shift();
    if (next === undefined) return false;
    return {
      content: Buffer.from(next.body),
      fields: { deliveryTag: 1, redelivered: next.redelivered, exchange: next.exchange, routingKey: next.routingKey },
      properties: {},
    };
  }
  nack(_message: unknown, _allUpTo?: boolean, requeue?: boolean) {
    nacked.push({ requeue: requeue === true });
  }
  publish(exchange: string, routingKey: string, content: Uint8Array, options?: { headers?: Record<string, unknown> }) {
    published.push({ exchange, routingKey, body: Buffer.from(content).toString(), headers: options?.headers ?? {} });
    return true;
  }
  async purgeQueue(name: string) {
    if (!(name in queues)) {
      const error = new Error("NOT-FOUND") as Error & { code: number };
      error.code = 404;
      throw error;
    }
    purged.push(name);
    queues[name] = [];
    return { messageCount: 0 };
  }
  async close() {}
  on() {}
}

class FakeConnection {
  static lastUrl = "";
  constructor(url: string) {
    FakeConnection.lastUrl = url;
  }
  async createChannel() {
    return new FakeChannel();
  }
  async close() {}
  on() {}
}

const mockConnect = mock(async (url: string) => {
  if (url.includes("localhost:1")) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  return new FakeConnection(url);
});

mock.module("amqplib", () => ({ connect: mockConnect }));

// Importing the module self-registers the rabbitmq loader, like production.
const { RabbitMQProvider } = await import("@/lib/resources/providers/messaging/rabbitmq");

const connection: ResourceConnection = {
  id: "res-1",
  name: "rabbit",
  type: "rabbitmq",
  createdAt: "2026-01-01T00:00:00.000Z",
  connectionString: "amqp://probe:probe@localhost:5672/%2f",
};

function mockManagement() {
  mockGlobalFetch({
    "api/exchanges": {
      json: [{ name: "fixture.events" }, { name: "" }, { name: "amq.direct" }, { name: "amq.fanout" }],
    },
    "api/queues": { json: [{ name: "fixture.orders" }] },
  });
}

function seed() {
  for (const key of Object.keys(queues)) delete queues[key];
  queues["fixture.orders"] = [
    { body: "hello-1", exchange: "", routingKey: "fixture.orders", redelivered: false },
    { body: "hello-2", exchange: "", routingKey: "fixture.orders", redelivered: true },
  ];
}

describe("RabbitMQProvider", () => {
  beforeEach(() => {
    seed();
    published.length = 0;
    purged.length = 0;
    nacked.length = 0;
    restoreGlobalFetch();
    mockManagement();
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("rabbitmq");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(RabbitMQProvider);
  });

  test("refuses a connection with neither URI nor endpoint", () => {
    expect(() => new RabbitMQProvider({ ...connection, connectionString: undefined })).toThrow(ResourceConfigError);
  });

  test("connect dials the URI and disconnect is silent", async () => {
    const provider = new RabbitMQProvider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(FakeConnection.lastUrl).toBe("amqp://probe:probe@localhost:5672/%2f");
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("a refusing broker surfaces as a connection error", async () => {
    const provider = new RabbitMQProvider({ ...connection, connectionString: "amqp://u:p@localhost:1/%2f" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("lists user exchanges and queues, filtering broker furniture", async () => {
    const provider = new RabbitMQProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.nodes.map((node) => node.id).sort()).toEqual(["exchange/fixture.events", "queue/fixture.orders"]);
    expect(page.nodes[0]).toMatchObject({ kind: "exchange", hasChildren: false });
  });

  test("browses with requeue and computed previews", async () => {
    const provider = new RabbitMQProvider(connection);
    const page = await provider.browseMessages("queue/fixture.orders", 10);
    expect(page.truncated).toBe(false);
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({ id: "queue/fixture.orders/1", kind: "message" });
    expect(page.messages[0].meta).toMatchObject({ routingKey: "fixture.orders", preview: "hello-1" });
    // Every peeked message is requeued: the queue is as it was found.
    expect(nacked).toHaveLength(2);
    expect(nacked.every((nack) => nack.requeue)).toBe(true);
  });

  test("browsing an exchange is refused with the honest sentence", async () => {
    const provider = new RabbitMQProvider(connection);
    const error = await provider.browseMessages("exchange/fixture.events", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceOperationUnsupportedError);
    expect((error as Error).message).toContain("cannot be browsed");
  });

  test("a missing queue is a 404, not a crashed channel", async () => {
    const provider = new RabbitMQProvider(connection);
    const error = await provider.browseMessages("queue/nope", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("publishes to a queue through the default exchange", async () => {
    const provider = new RabbitMQProvider(connection);
    await provider.publishMessage("queue/fixture.orders", "hello-new");
    expect(published).toEqual([{ exchange: "", routingKey: "fixture.orders", body: "hello-new", headers: {} }]);
  });

  test("publishes to an exchange with the routing key, headers pass through", async () => {
    const provider = new RabbitMQProvider(connection);
    await provider.publishMessage("exchange/fixture.events", "hello-ex", {
      routingKey: "orders.created",
      trace: "abc",
    });
    expect(published).toEqual([
      { exchange: "fixture.events", routingKey: "orders.created", body: "hello-ex", headers: { trace: "abc" } },
    ]);
  });

  test("publishing to a missing destination is a 404", async () => {
    const provider = new RabbitMQProvider(connection);
    const error = await provider.publishMessage("queue/nope", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("purges a queue; purging an exchange is refused", async () => {
    const provider = new RabbitMQProvider(connection);
    await provider.purgeQueue("queue/fixture.orders");
    expect(purged).toEqual(["fixture.orders"]);

    const error = await provider.purgeQueue("exchange/fixture.events").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceOperationUnsupportedError);
  });

  test("capabilities declare the full messaging surface", () => {
    const provider = new RabbitMQProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "messaging", defaultPort: 5672 });
    expect(provider.getCapabilities().operations).toEqual([
      "tree",
      "message.browse",
      "message.publish",
      "message.purge",
    ]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Destinations", itemNoun: "Messages" });
  });
});
