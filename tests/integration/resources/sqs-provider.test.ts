import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * SQS provider tests. The SDK is doubled with mock.module; every answer is
 * shaped from a live pass against LocalStack (measured 2026-09-20):
 * - Queue URLs carry the name as the last segment; the tree lists bare names.
 * - A missing queue on GetQueueUrl answers QueueDoesNotExist.
 * - Receives arrive in pages of up to 10; an empty round ends the peek, so
 *   `truncated` is measured, not assumed.
 * - LocalStack v3 answers SentTimestamp in MICROseconds (AWS: millis) — the
 *   provider reads the magnitude, verified by the year-58688 catch below.
 */

function fakeCommand(name: string, input: unknown) {
  return { commandName: name, input };
}

class FakeListQueuesCommand {
  readonly commandName = "ListQueuesCommand";
  constructor(public readonly input: unknown) {}
}
class FakeGetQueueUrlCommand {
  readonly commandName = "GetQueueUrlCommand";
  constructor(public readonly input: unknown) {}
}
class FakeReceiveMessageCommand {
  readonly commandName = "ReceiveMessageCommand";
  constructor(public readonly input: unknown) {}
}
class FakeSendMessageCommand {
  readonly commandName = "SendMessageCommand";
  constructor(public readonly input: unknown) {}
}
class FakePurgeQueueCommand {
  readonly commandName = "PurgeQueueCommand";
  constructor(public readonly input: unknown) {}
}

interface QueueState {
  url: string;
  messages: Array<{ id: string; body: string; timestamp: string }>;
}

const queues: Record<string, QueueState> = {};

const sentCalls: Array<{ command: string; input: unknown }> = [];
const sentMessages: Array<{ queue: string; body: string; group?: string }> = [];
const purged: string[] = [];

function sqsError(name: string, message: string) {
  const error = new Error(message) as Error & { name: string };
  error.name = name;
  return error;
}

class FakeSQSClient {
  static lastConfig: unknown = null;
  private readonly config: { endpoint?: string };
  constructor(config: { endpoint?: string }) {
    FakeSQSClient.lastConfig = config;
    this.config = config;
  }
  destroy() {}
  async send(command: { commandName: string; input: Record<string, unknown> }): Promise<unknown> {
    if (this.config.endpoint === "http://localhost:1") throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    sentCalls.push({ command: command.commandName, input: command.input });
    switch (command.commandName) {
      case "ListQueuesCommand":
        return { QueueUrls: Object.values(queues).map((queue) => queue.url) };
      case "GetQueueUrlCommand": {
        const name = command.input.QueueName as string;
        if (!(name in queues)) throw sqsError("QueueDoesNotExist", `Unknown queue ${name}`);
        return { QueueUrl: queues[name].url };
      }
      case "ReceiveMessageCommand": {
        const url = command.input.QueueUrl as string;
        const queue = Object.values(queues).find((q) => q.url === url);
        if (!queue) throw sqsError("QueueDoesNotExist", `Unknown queue ${url}`);
        // Non-destructive, like visibility-zero redelivery: the same messages
        // answer every round until the bound stops the loop. An empty queue
        // answers empty, which is the provider's only drain signal.
        const max = Math.min(10, command.input.MaxNumberOfMessages as number);
        expect(command.input.VisibilityTimeout).toBe(0);
        const batch = queue.messages.slice(0, max);
        return {
          Messages: batch.map((message) => ({
            MessageId: message.id,
            Body: message.body,
            Attributes: { SentTimestamp: message.timestamp },
          })),
        };
      }
      case "SendMessageCommand": {
        const url = command.input.QueueUrl as string;
        const queue = Object.values(queues).find((q) => q.url === url);
        if (!queue) throw sqsError("QueueDoesNotExist", `Unknown queue ${url}`);
        queue.messages.push({
          id: `msg-${queue.messages.length}`,
          body: command.input.MessageBody as string,
          timestamp: "1789858000000000",
        });
        sentMessages.push({
          queue: url,
          body: command.input.MessageBody as string,
          group: command.input.MessageGroupId as string | undefined,
        });
        return { MessageId: "new-id" };
      }
      case "PurgeQueueCommand": {
        const url = command.input.QueueUrl as string;
        const queue = Object.values(queues).find((q) => q.url === url);
        if (!queue) throw sqsError("QueueDoesNotExist", `Unknown queue ${url}`);
        purged.push(url);
        queue.messages = [];
        return {};
      }
      default:
        throw new Error(`unexpected command ${command.commandName}`);
    }
  }
}

mock.module("@aws-sdk/client-sqs", () => ({
  SQSClient: FakeSQSClient,
  ListQueuesCommand: FakeListQueuesCommand,
  GetQueueUrlCommand: FakeGetQueueUrlCommand,
  ReceiveMessageCommand: FakeReceiveMessageCommand,
  SendMessageCommand: FakeSendMessageCommand,
  PurgeQueueCommand: FakePurgeQueueCommand,
}));

// Importing the module self-registers the sqs loader, like production.
const { SqsProvider } = await import("@/lib/resources/providers/messaging/sqs");

const connection: ResourceConnection = {
  id: "res-1",
  name: "queues",
  type: "sqs",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
  accessKeyId: "test",
  secretAccessKey: "test",
};

function seed() {
  for (const key of Object.keys(queues)) delete queues[key];
  queues["fixture-events"] = {
    url: "http://localhost:4567/000000000000/fixture-events",
    messages: [
      { id: "m1", body: "hello-1", timestamp: "1789858000000000" },
      { id: "m2", body: "hello-2", timestamp: "1789858000000000" },
    ],
  };
}

describe("SqsProvider", () => {
  beforeEach(() => {
    seed();
    sentCalls.length = 0;
    sentMessages.length = 0;
    purged.length = 0;
    FakeSQSClient.lastConfig = null;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("sqs");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(SqsProvider);
  });

  test("refuses a connection with no region", () => {
    expect(() => new SqsProvider({ ...connection, region: undefined })).toThrow(ResourceConfigError);
  });

  test("endpoint override and credentials reach the client", async () => {
    const provider = new SqsProvider({ ...connection, endpoint: "http://localhost:4567" });
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(FakeSQSClient.lastConfig).toMatchObject({ region: "us-east-1", endpoint: "http://localhost:4567" });
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("lists queues by bare name", async () => {
    const provider = new SqsProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.truncated).toBe(false);
    expect(page.nodes).toEqual([
      { id: "queue/fixture-events", parentId: null, kind: "queue", name: "fixture-events", hasChildren: false },
    ]);
  });

  test("browses with previews and a measured truncation flag", async () => {
    const provider = new SqsProvider(connection);
    // Two messages, redelivered every round: the bound (not the queue) ends
    // the peek, so a limit-10 browse fills 10 and reports truncated.
    const page = await provider.browseMessages("queue/fixture-events", 10);
    expect(page.truncated).toBe(true);
    expect(page.messages).toHaveLength(10);
    expect(page.messages[0]).toMatchObject({ id: "queue/fixture-events/m1", kind: "message", name: "m1" });
    expect(page.messages[0].meta?.preview).toBe("hello-1");

    const capped = await provider.browseMessages("fixture-events", 1);
    expect(capped.messages).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  test("an empty queue drains to an untruncated empty page", async () => {
    queues["fixture-events"].messages = [];
    const provider = new SqsProvider(connection);
    const page = await provider.browseMessages("fixture-events", 10);
    expect(page.messages).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  test("microsecond timestamps read as dates, not year 58688", async () => {
    const provider = new SqsProvider(connection);
    const page = await provider.browseMessages("fixture-events", 10);
    const timestamp = page.messages[0].meta?.timestamp as string;
    expect(new Date(timestamp).getFullYear()).toBeLessThan(2100);
  });

  test("receives peek with visibility zero", async () => {
    const provider = new SqsProvider(connection);
    await provider.browseMessages("fixture-events", 10);
    const receives = sentCalls.filter((call) => call.command === "ReceiveMessageCommand");
    expect(receives.length).toBeGreaterThan(0);
    for (const call of receives) {
      expect((call.input as Record<string, unknown>).VisibilityTimeout).toBe(0);
    }
  });

  test("a missing queue is a 404", async () => {
    const provider = new SqsProvider(connection);
    const error = await provider.browseMessages("no-queue", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("publishes with string attributes and fifo group default", async () => {
    const provider = new SqsProvider(connection);
    await provider.publishMessage("fixture-events", "hello-new", { trace: "abc" });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].body).toBe("hello-new");
    expect(sentMessages[0].group).toBeUndefined();

    queues["orders.fifo"] = { url: "http://localhost:4567/000000000000/orders.fifo", messages: [] };
    await provider.publishMessage("orders.fifo", "x");
    expect(sentMessages[1].group).toBe("storagebase");
    await provider.publishMessage("orders.fifo", "y", { MessageGroupId: "g7" });
    expect(sentMessages[2].group).toBe("g7");
  });

  test("purges a queue", async () => {
    const provider = new SqsProvider(connection);
    await provider.purgeQueue("fixture-events");
    expect(purged).toEqual(["http://localhost:4567/000000000000/fixture-events"]);
    expect(queues["fixture-events"].messages).toEqual([]);
  });

  test("a refusing endpoint surfaces as a connection error", async () => {
    const provider = new SqsProvider({ ...connection, endpoint: "http://localhost:1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("capabilities declare the full messaging surface", () => {
    const provider = new SqsProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "messaging", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toEqual([
      "tree",
      "message.browse",
      "message.publish",
      "message.purge",
    ]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Queues", itemNoun: "Messages" });
  });
});
