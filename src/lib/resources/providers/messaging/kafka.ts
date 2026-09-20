import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import {
  ResourceConfigError,
  ResourceConnectionError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
} from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNode,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type { BrowseMessagesPage, MessagingOperations } from "../../operations";

/**
 * The Apache Kafka provider. The connection's `endpoint` is the bootstrap
 * list (`broker1:9092,broker2:9092`), the only addressing Kafka has — there
 * is no username, no vhost, no namespace, which is why the form offers just
 * the one field.
 *
 * Two honest refusals, both from the plan's risk register:
 * - No SASL/TLS surfacing in M3: the connection record carries no credential
 *   fields for Kafka, so a SASL cluster fails at connect with the broker's
 *   sentence, not as a half-configured form. SASL is M-future, not silent.
 * - No purge: Kafka has no delete-records-by-topic semantic a provider may
 *   call "purge", so `purgeQueue` throws `ResourceOperationUnsupportedError`
 *   and the type never declares `message.purge` — the route refuses before
 *   any socket opens.
 *
 * Peek reads from the beginning up to `limit` (bounded, oldest first) after
 * measuring the total available, so `truncated` is computed, not guessed.
 * Message bodies ride in node `meta.preview` (200 chars); the full body is
 * M-future, documented in docs/resources/kafka.md rather than smuggled.
 */

import { loadResourceSdk } from "../../sdk-loader";

type KafkaModule = typeof import("kafkajs");

function loadKafka(): Promise<KafkaModule> {
  return loadResourceSdk<KafkaModule>("kafkajs", "Kafka client (kafkajs)", "bun add kafkajs");
}

export const KAFKA_BROWSE_LIMIT = 100;

export const KAFKA_PREVIEW_CHARS = 200;

/**
 * Upper bound on one peek's wait. The target (min(bound, measured total))
 * ends the wait on a healthy cluster in milliseconds; the deadline only ever
 * fires against a sick one, where hanging the route would be worse than a
 * partial page with an honest truncation flag.
 */
export const KAFKA_BROWSE_TIMEOUT_MS = 15_000;

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Kafka ${what} failed: ${message}`);
}

function previewOf(value: Uint8Array | null): { preview: string; truncated: boolean } {
  if (value === null) return { preview: "", truncated: false };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(value.slice(0, KAFKA_PREVIEW_CHARS + 1));
  if (text.includes("�")) return { preview: "", truncated: true };
  return {
    preview: text.slice(0, KAFKA_PREVIEW_CHARS),
    truncated: text.length > KAFKA_PREVIEW_CHARS,
  };
}

export class KafkaProvider extends BaseResourceProvider implements MessagingOperations {
  private kafka: InstanceType<KafkaModule["Kafka"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.endpoint) {
      throw new ResourceConfigError('A Kafka connection requires an "endpoint" bootstrap list (broker1:9092,...)');
    }
  }

  private async getKafka(): Promise<InstanceType<KafkaModule["Kafka"]>> {
    if (this.kafka) return this.kafka;
    const sdk = await loadKafka();
    this.kafka = new sdk.Kafka({
      clientId: `storagebase-studio-${this.config.id}`,
      brokers: (this.config.endpoint as string).split(",").map((broker) => broker.trim()),
    });
    return this.kafka;
  }

  public async connect(): Promise<void> {
    try {
      // kafkajs connects lazily: constructing proves nothing, so the probe
      // lists topics. A SASL cluster fails HERE with the broker's sentence.
      await this.listDestinations();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    this.kafka = null;
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    await this.listDestinations();
    return { status: "healthy", latencyMs: Date.now() - start };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "messaging",
      defaultPort: 9092,
      supportsSshTunnel: false,
      operations: ["tree", "message.browse", "message.publish"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Topics", itemNoun: "Messages" };
  }

  public async listNodes(_parentId: string | null): Promise<ResourceNodePage> {
    // Topics have no children: nothing below them is listable, so any parent
    // address answers empty rather than re-listing the roots under it (which
    // would draw every topic as its own child).
    if (_parentId !== null) return { nodes: [], truncated: false };
    return this.listDestinations();
  }

  public async listDestinations(): Promise<ResourceNodePage> {
    try {
      const kafka = await this.getKafka();
      const admin = kafka.admin();
      await admin.connect();
      try {
        const topics = await admin.listTopics();
        return {
          nodes: topics
            .filter((topic) => !topic.startsWith("__"))
            .map((topic) => ({
              id: `topic/${topic}`,
              parentId: null,
              kind: "topic",
              name: topic,
              hasChildren: false,
            })),
          truncated: false,
        };
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    } catch (error) {
      throw toConnectionError(error, "list topics");
    }
  }

  public async browseMessages(destination: string, limit: number): Promise<BrowseMessagesPage> {
    const bounded = Math.max(1, Math.min(limit, KAFKA_BROWSE_LIMIT));
    const { name } = splitDestination(destination);
    try {
      const kafka = await this.getKafka();
      const admin = kafka.admin();
      await admin.connect();
      let topics: string[];
      let offsets: Array<{ partition: number; high: string; low: string }>;
      try {
        // Existence first, offsets second: the offsets call's missing-topic
        // shape is retry behavior, not a stable code, so resolving against
        // the listing is what makes "no such topic" decidable here.
        topics = await admin.listTopics();
        if (!topics.includes(name)) {
          throw new ResourceNotFoundError(`Topic "${name}" does not exist`);
        }
        offsets = await admin.fetchTopicOffsets(name);
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
      if (offsets.length === 0) {
        throw new ResourceNotFoundError(`Topic "${destination}" does not exist`);
      }
      const total = offsets.reduce((sum, entry) => sum + (Number(entry.high) - Number(entry.low)), 0);
      // The stop condition is min(bounded, total): without it a topic holding
      // fewer messages than the limit would keep the consumer running forever,
      // waiting for arrivals nobody asked to see.
      const target = Math.min(bounded, total);
      if (target === 0) return { messages: [], truncated: false };

      const consumer = kafka.consumer({ groupId: `storagebase-peek-${this.config.id}-${Date.now()}` });
      await consumer.connect();
      try {
        await consumer.subscribe({ topic: name, fromBeginning: true });
        const messages: ResourceNode[] = [];
        let stopped = false;
        // NOTE: `run()` resolves once fetching STARTS, not when it finishes —
        // delivery lands in the handler over time. So the wait below (not the
        // `await run`) is what bounds the peek: it ends at the target or the
        // deadline, whichever comes first. Misreading this as "run blocks
        // until stop" disconnects before the first fetch answers (measured).
        await consumer.run({
          autoCommit: false,
          eachMessage: async ({ topic, partition, message }) => {
            // Cap at the target on push, not just at the wait loop: a burst
            // of deliveries between two 100ms polls would otherwise overshoot
            // the page the caller asked for.
            if (messages.length >= target) return;
            const preview = previewOf(message.value);
            messages.push({
              id: `topic/${topic}/${partition}/${message.offset}`,
              parentId: `topic/${topic}`,
              kind: "message",
              name: message.key === null ? `#${message.offset}` : message.key.toString(),
              meta: {
                partition,
                offset: message.offset,
                ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
                ...(message.key === null ? {} : { key: message.key.toString() }),
                preview: preview.preview,
                ...(preview.truncated ? { previewTruncated: true } : {}),
              },
              hasChildren: false,
            });
            if (messages.length >= target && !stopped) {
              stopped = true;
              // NOT awaited, on purpose: stop() waits for the running batch
              // (CONSUMING_STOP) while this handler IS the running batch, so
              // awaiting it here deadlocks (measured: parked forever after the
              // fetch answers). The outer finally performs the awaited stop;
              // concurrent stop() calls share one promise.
              void consumer.stop().catch(() => undefined);
            }
          },
        });
        const deadline = Date.now() + KAFKA_BROWSE_TIMEOUT_MS;
        while (messages.length < target && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { messages, truncated: total > bounded };
      } finally {
        await consumer.stop().catch(() => undefined);
        await consumer.disconnect().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `browse "${destination}"`); // destination kept: it is what the caller addressed
    }
  }

  public async publishMessage(destination: string, body: string, attributes?: Record<string, string>): Promise<void> {
    const { name } = splitDestination(destination);
    try {
      const kafka = await this.getKafka();
      const producer = kafka.producer();
      await producer.connect();
      try {
        await producer.send({
          topic: name,
          messages: [
            {
              value: body,
              ...(attributes?.key !== undefined ? { key: attributes.key } : {}),
              ...(attributes && Object.keys(attributes).length > 0
                ? {
                    headers: Object.fromEntries(
                      Object.entries(attributes)
                        .filter(([name]) => name !== "key")
                        .map(([name, value]) => [name, Buffer.from(value)]),
                    ),
                  }
                : {}),
            },
          ],
        });
      } finally {
        await producer.disconnect().catch(() => undefined);
      }
    } catch (error) {
      throw toConnectionError(error, `publish to "${destination}"`);
    }
  }

  public async purgeQueue(destination: string): Promise<void> {
    // Kafka has no purge: retention is time/size policy, not an operation.
    // Refusing beats faking (deleting and recreating the topic would drop
    // consumers' offsets — data loss wearing a feature's clothes).
    throw new ResourceOperationUnsupportedError(
      `Kafka topic "${destination}" cannot be purged: Kafka has no purge operation`,
    );
  }
}

/**
 * Split a destination id back to its bare topic name. Ids are `topic/<name>`;
 * publish callers may pass the bare name. Only the scheme prefix is stripped
 * — the rest is preserved verbatim, so names containing `/` round-trip.
 */
function splitDestination(destination: string): { name: string } {
  return { name: destination.startsWith("topic/") ? destination.slice("topic/".length) : destination };
}

registerResourceProviderLoader("kafka", () => import("./kafka").then((m) => ({ default: m.KafkaProvider })));
