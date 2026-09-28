import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import {
  ResourceConfigError,
  ResourceConflictError,
  ResourceConnectionError,
  ResourceError,
  ResourceInvalidRequestError,
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
import type {
  BrowseMessagesPage,
  KafkaAdminOperations,
  KafkaClusterOverview,
  KafkaConfigEntry,
  KafkaConsumerGroupDetail,
  KafkaConsumerGroupListing,
  KafkaCreateTopicInput,
  KafkaGroupLag,
  KafkaGroupMember,
  KafkaGroupOffset,
  KafkaMessagesPage,
  KafkaProduceInput,
  KafkaProduceResult,
  KafkaReadQuery,
  KafkaRecord,
  KafkaResetOffsetsInput,
  KafkaSeek,
  KafkaTopicCount,
  KafkaTopicDetail,
  KafkaTopicListing,
  MessagingOperations,
} from "../../operations";
import { KAFKA_MEASURE_BATCH_LIMIT } from "../../operations";

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
 * Message bodies ride in node `meta.preview` (200 chars) on that generic
 * path; the Kafka workbench reads through `readMessages` instead, which seeks
 * (earliest / tail / offset / timestamp), returns full bodies up to a
 * per-record cap and is bounded by count, bytes and time.
 *
 * The workbench surface (`KafkaAdminOperations`) is cluster, topic-admin and
 * consumer-group management. Every call opens and closes its own admin
 * client: kafkajs admins hold broker sockets, and a cached one would outlive
 * the provider's idle eviction.
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

/** The workbench read's hard page bound; the route enforces the same ceiling. */
export const KAFKA_READ_LIMIT = 200;

/** Per-record value cap: past it the value is cut and flagged, never dropped silently. */
export const KAFKA_VALUE_MAX_BYTES = 64 * 1024;

/**
 * Whole-read byte budget. Count x value cap alone would allow ~12 MiB per
 * page; the budget ends the read earlier with `truncated` set instead.
 */
export const KAFKA_READ_BYTE_BUDGET = 8 * 1024 * 1024;

/** The throwaway groups the studio's own reads join. Listed as internal, deleted after each workbench read. */
export const KAFKA_PEEK_GROUP_PREFIX = "storagebase-peek-";

/**
 * Offset reads in flight at once on one admin client. Small on purpose: a
 * count batch fans out one ListOffsets pair per topic, and a wide fan-out over a
 * shared admin is where kafkajs' "write after end" socket errors showed up.
 */
export const KAFKA_OFFSET_CONCURRENCY = 4;

/**
 * Wall-clock bound on one lazy-measurement batch (counts or lag). kafkajs retries a sick broker
 * for tens of seconds per call; past the deadline the names still pending answer a timeout
 * reason instead, and the batch returns.
 */
let measureDeadlineMs = 20_000;

/**
 * How long a topic's end offsets are reused across lag batches. A "measure every group" sweep
 * sends dozens of batches in a row, and a topic ten groups consume would otherwise be read once
 * per batch; a few seconds of staleness on a lag figure is below what it can resolve anyway.
 */
let endOffsetTtlMs = 5_000;

export function setKafkaMeasureTimingForTest(timing: { deadlineMs?: number; endOffsetTtlMs?: number }): void {
  measureDeadlineMs = timing.deadlineMs ?? 20_000;
  endOffsetTtlMs = timing.endOffsetTtlMs ?? 5_000;
}

/** The internal topic whose partition leaders are the group coordinators. */
const GROUP_OFFSETS_TOPIC = "__consumer_offsets";

/** Java's `String.hashCode()`: 31-based over UTF-16 code units, wrapped to int32. */
export function javaStringHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return hash;
}

/**
 * The `__consumer_offsets` partition a group lives on — Kafka's own
 * `Utils.abs(groupId.hashCode()) % partitionCount`, where `Utils.abs` maps
 * Integer.MIN_VALUE to 0 rather than overflowing.
 */
export function groupOffsetsPartition(groupId: string, partitionCount: number): number {
  const hash = javaStringHash(groupId);
  return (hash === -2147483648 ? 0 : Math.abs(hash)) % partitionCount;
}

/** kafkajs `ConfigResourceTypes.TOPIC`, spelled here so the SDK stays lazily loaded. */
const TOPIC_CONFIG_RESOURCE = 2;

/** kafkajs `ConfigSource`, by wire value. */
const CONFIG_SOURCE_NAMES: Record<number, string> = {
  0: "UNKNOWN",
  1: "TOPIC_CONFIG",
  2: "DYNAMIC_BROKER_CONFIG",
  3: "DYNAMIC_DEFAULT_BROKER_CONFIG",
  4: "STATIC_BROKER_CONFIG",
  5: "DEFAULT_CONFIG",
  6: "DYNAMIC_BROKER_LOGGER_CONFIG",
};

/** Broker refusals that are the caller's to fix: 400, with the broker's sentence. */
const INVALID_REQUEST_TYPES = new Set([
  "INVALID_REPLICATION_FACTOR",
  "INVALID_PARTITIONS",
  "INVALID_CONFIG",
  "INVALID_TOPIC_EXCEPTION",
  "INVALID_REPLICA_ASSIGNMENT",
  "POLICY_VIOLATION",
  "INVALID_REQUEST",
]);

/** Refusals about the resource's current state: 409. */
const CONFLICT_TYPES = new Set(["TOPIC_ALREADY_EXISTS", "NON_EMPTY_GROUP", "REBALANCE_IN_PROGRESS"]);

const NOT_FOUND_TYPES = new Set(["UNKNOWN_TOPIC_OR_PARTITION", "GROUP_ID_NOT_FOUND"]);

/**
 * The protocol error behind a kafkajs failure. Admin calls wrap them:
 * createTopics in a KafkaJSAggregateError (`errors`), deleteGroups in a
 * KafkaJSDeleteGroupsError (`groups[].error`). The nested error is the one
 * whose sentence names the actual refusal.
 */
function protocolErrorOf(error: unknown): { type: string; message?: unknown } | null {
  if (typeof error !== "object" || error === null) return null;
  const shaped = error as { type?: unknown; errors?: unknown[]; groups?: Array<{ error?: unknown }> };
  if (typeof shaped.type === "string") return shaped as { type: string; message?: unknown };
  const nested = shaped.errors?.[0] ?? shaped.groups?.find((group) => group.error !== undefined)?.error;
  return nested === undefined ? null : protocolErrorOf(nested);
}

/** Map a workbench failure onto the resource error vocabulary; typed refusals pass through untouched. */
function translateKafkaError(error: unknown, what: string): ResourceError {
  if (error instanceof ResourceError) return error;
  const protocol = protocolErrorOf(error);
  if (protocol === null) return toConnectionError(error, what);
  const sentence = `Kafka ${what}: ${String(protocol.message ?? protocol.type)}`;
  if (INVALID_REQUEST_TYPES.has(protocol.type)) return new ResourceInvalidRequestError(sentence);
  if (CONFLICT_TYPES.has(protocol.type)) return new ResourceConflictError(sentence);
  if (NOT_FOUND_TYPES.has(protocol.type)) return new ResourceNotFoundError(sentence);
  return toConnectionError(error, what);
}

type KafkaAdmin = ReturnType<InstanceType<KafkaModule["Kafka"]>["admin"]>;

/** A topic's end offsets by partition, or why they could not be read. */
type EndOffsets = Promise<Map<number, string> | string>;

type EndOffsetReader = (admin: KafkaAdmin, topic: string) => EndOffsets;

interface ReadWindow {
  readonly partition: number;
  /** Inclusive. */
  readonly start: bigint;
  /** Exclusive. */
  readonly end: bigint;
}

/**
 * Split `limit` across partitions by water-filling: every partition with data
 * gets an equal share, and what a short partition cannot use flows to the
 * others. So a skewed topic (one busy partition, eleven idle) still answers a
 * full page, and the sum never exceeds `limit` — the bound is exact.
 */
export function allocateReadQuotas(available: readonly number[], limit: number): number[] {
  const quotas = available.map(() => 0);
  let remaining = limit;
  let open = available.flatMap((count, index) => (count > 0 ? [index] : []));
  while (remaining > 0 && open.length > 0) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const index of open) {
      const take = Math.min(share, available[index] - quotas[index], remaining);
      quotas[index] += take;
      remaining -= take;
    }
    open = open.filter((index) => quotas[index] < available[index]);
  }
  return quotas;
}

function clampOffset(value: bigint, low: bigint, high: bigint): bigint {
  if (value < low) return low;
  return value > high ? high : value;
}

/** Bytes to text when they are clean UTF-8, base64 otherwise — binary is shown, never mangled. */
function decodeBytes(
  bytes: Buffer | null,
  cap: number,
): { text: string | null; encoding: "utf8" | "base64"; truncated: boolean; size: number } {
  if (bytes === null) return { text: null, encoding: "utf8", truncated: false, size: 0 };
  const truncated = bytes.length > cap;
  const slice = truncated ? bytes.subarray(0, cap) : bytes;
  try {
    // `stream` on a cut slice: a multi-byte character split by the cap is
    // buffered as incomplete rather than reported as invalid UTF-8.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice, { stream: truncated });
    return { text, encoding: "utf8", truncated, size: bytes.length };
  } catch {
    return { text: Buffer.from(slice).toString("base64"), encoding: "base64", truncated, size: bytes.length };
  }
}

function decodeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    decoded[name] = values
      .map((entry) => (typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8")))
      .join(", ");
  }
  return decoded;
}

function compareRecords(a: KafkaRecord, b: KafkaRecord): number {
  const byTime = Number(a.timestamp) - Number(b.timestamp);
  if (byTime !== 0) return byTime;
  if (a.partition !== b.partition) return a.partition - b.partition;
  return Number(BigInt(a.offset) - BigInt(b.offset));
}

/** Run `task` over `items` with at most `width` in flight, results in input order. */
async function mapBounded<T, R>(items: readonly T[], width: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * `mapBounded` under the measurement deadline: an item still running (or not
 * yet started) when it passes answers `timedOut(item)` instead, so a batch
 * against a sick broker returns at the deadline with every name accounted for.
 */
async function mapBoundedWithDeadline<T, R>(
  items: readonly T[],
  width: number,
  task: (item: T) => Promise<R>,
  timedOut: (item: T) => R,
): Promise<R[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), measureDeadlineMs);
  });
  let passed = false;
  void expired.then(() => {
    passed = true;
  });
  try {
    return await mapBounded(items, width, async (item) => {
      if (passed) return timedOut(item);
      const outcome = await Promise.race([task(item), expired]);
      return outcome === "expired" ? timedOut(item) : outcome;
    });
  } finally {
    clearTimeout(timer);
  }
}

function deadlineReason(): string {
  return `not measured within ${measureDeadlineMs / 1000}s`;
}

/** One line for a tooltip: why a best-effort read came back empty. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a topic's offsets are not worth asking for, read off its metadata:
 * kafkajs routes ListOffsets per partition leader, and a partition with no
 * leader (or no partitions at all, a topic mid-deletion) is exactly the case
 * where its response comes back short and it throws from inside the client.
 */
function unreadableOffsets(partitions: ReadonlyArray<{ partitionId: number; leader: number }>): string | null {
  if (partitions.length === 0) return "no partition metadata (the topic may be being deleted)";
  const leaderless = partitions.find((partition) => partition.leader < 0);
  return leaderless === undefined ? null : `partition ${leaderless.partitionId} has no leader`;
}

function sumWatermarks(offsets: ReadonlyArray<{ high: string; low: string }>): number {
  return offsets.reduce((sum, entry) => sum + (Number(entry.high) - Number(entry.low)), 0);
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

export class KafkaProvider extends BaseResourceProvider implements MessagingOperations, KafkaAdminOperations {
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
      operations: [
        "tree",
        "message.browse",
        "message.publish",
        "kafka.inspect",
        "kafka.topic.write",
        "kafka.produce",
        "kafka.group.write",
      ],
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

  // --- Kafka workbench (KafkaAdminOperations) ---

  /** One admin client per call, always disconnected; failures leave in the resource vocabulary. */
  private async withAdmin<T>(what: string, run: (admin: KafkaAdmin) => Promise<T>): Promise<T> {
    try {
      const kafka = await this.getKafka();
      const admin = kafka.admin();
      await admin.connect();
      try {
        return await run(admin);
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    } catch (error) {
      throw translateKafkaError(error, what);
    }
  }

  /**
   * Existence from the listing, the browse ruling: missing-topic shapes from
   * the metadata and offsets calls are retry behaviour, not a stable code.
   */
  private async requireTopic(admin: KafkaAdmin, topic: string): Promise<void> {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) throw new ResourceNotFoundError(`Topic "${topic}" does not exist`);
  }

  public async describeCluster(): Promise<KafkaClusterOverview> {
    return this.withAdmin("describe cluster", async (admin) => {
      const cluster = await admin.describeCluster();
      return {
        clusterId: cluster.clusterId,
        controllerId: cluster.controller,
        brokers: [...cluster.brokers]
          .sort((a, b) => a.nodeId - b.nodeId)
          .map((broker) => ({
            nodeId: broker.nodeId,
            host: broker.host,
            port: broker.port,
            rack: null,
            isController: broker.nodeId === cluster.controller,
          })),
      };
    });
  }

  /**
   * Metadata only: one round trip answers every topic, so ~700 topics list in
   * the time of one request. Counts are `countTopicMessages`' job — asked for
   * by the rows on screen, never for the whole cluster up front.
   */
  public async listTopicSummaries(): Promise<KafkaTopicListing> {
    return this.withAdmin("list topics", async (admin) => {
      const { topics } = await admin.fetchTopicMetadata();
      return {
        topics: [...topics]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((topic) => ({
            name: topic.name,
            internal: topic.name.startsWith("__"),
            partitions: topic.partitions.length,
            replicationFactor: Math.max(0, ...topic.partitions.map((partition) => partition.replicas.length)),
            underReplicatedPartitions: topic.partitions.filter(
              (partition) => partition.isr.length < partition.replicas.length,
            ).length,
          })),
      };
    });
  }

  /**
   * Approximate message counts for a bounded batch of topics, a few offset
   * reads in flight at a time. Each is best effort: a topic whose offsets
   * cannot be read (measured on a live cluster: kafkajs throws a TypeError
   * from inside its offset fetch when a topic's response comes back short)
   * answers null with its reason, and every other topic in the batch is still
   * counted.
   */
  public async countTopicMessages(topics: readonly string[]): Promise<Record<string, KafkaTopicCount>> {
    const names = boundedBatch(topics, "topics");
    if (names.length === 0) return {};
    return this.withAdmin("count topic messages", async (admin) => {
      // The whole cluster's metadata, not just the named topics: kafkajs
      // fails the entire metadata answer when any named topic is unknown, so
      // one deleted topic would cost the batch. Existence is read off this.
      const { topics: metadata } = await admin.fetchTopicMetadata();
      const partitionsOf = new Map(metadata.map((topic) => [topic.name, topic.partitions]));
      const counts = await mapBoundedWithDeadline(
        names,
        KAFKA_OFFSET_CONCURRENCY,
        async (name): Promise<KafkaTopicCount> => {
          const partitions = partitionsOf.get(name);
          if (partitions === undefined) return { messageCount: null, countError: "topic does not exist" };
          const skip = unreadableOffsets(partitions);
          if (skip !== null) return { messageCount: null, countError: skip };
          try {
            return { messageCount: sumWatermarks(await admin.fetchTopicOffsets(name)), countError: null };
          } catch (error) {
            return { messageCount: null, countError: reasonOf(error) };
          }
        },
        () => ({ messageCount: null, countError: deadlineReason() }),
      );
      return Object.fromEntries(names.map((name, index) => [name, counts[index]]));
    });
  }

  public async describeTopic(topic: string): Promise<KafkaTopicDetail> {
    return this.withAdmin(`describe "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      const partitions = metadata.topics[0]?.partitions ?? [];
      // Best effort, like the listing: partitions and configs still answer
      // when the offsets cannot be read, with the reason beside them.
      let offsets: Array<{ partition: number; high: string; low: string }> = [];
      let offsetsError = unreadableOffsets(partitions);
      if (offsetsError === null) {
        try {
          offsets = await admin.fetchTopicOffsets(topic);
        } catch (error) {
          offsetsError = reasonOf(error);
        }
      }
      const configs = await this.readTopicConfigs(admin, topic);
      return {
        name: topic,
        internal: topic.startsWith("__"),
        partitions: [...partitions]
          .sort((a, b) => a.partitionId - b.partitionId)
          .map((partition) => {
            const watermark = offsets.find((entry) => entry.partition === partition.partitionId);
            return {
              partition: partition.partitionId,
              leader: partition.leader,
              replicas: partition.replicas,
              isr: partition.isr,
              offlineReplicas: partition.offlineReplicas ?? [],
              earliestOffset: watermark?.low ?? null,
              latestOffset: watermark?.high ?? null,
            };
          }),
        configs,
        offsetsError,
      };
    });
  }

  private async readTopicConfigs(admin: KafkaAdmin, topic: string): Promise<KafkaConfigEntry[]> {
    const described = await admin.describeConfigs({
      resources: [{ type: TOPIC_CONFIG_RESOURCE, name: topic }],
      includeSynonyms: false,
    });
    const entries = described.resources[0]?.configEntries ?? [];
    return [...entries]
      .sort((a, b) => a.configName.localeCompare(b.configName))
      .map((entry) => ({
        name: entry.configName,
        value: entry.isSensitive ? null : entry.configValue,
        source: CONFIG_SOURCE_NAMES[entry.configSource] ?? "UNKNOWN",
        isDefault: entry.isDefault,
        readOnly: entry.readOnly,
        isSensitive: entry.isSensitive,
      }));
  }

  public async createTopic(input: KafkaCreateTopicInput): Promise<void> {
    await this.withAdmin(`create topic "${input.name}"`, async (admin) => {
      const created = await admin.createTopics({
        waitForLeaders: true,
        topics: [
          {
            topic: input.name,
            numPartitions: input.partitions,
            replicationFactor: input.replicationFactor,
            configEntries: Object.entries(input.configs ?? {}).map(([name, value]) => ({ name, value })),
          },
        ],
      });
      // kafkajs answers `false`, not an error, when every topic already existed.
      if (!created) throw new ResourceConflictError(`Topic "${input.name}" already exists`);
    });
  }

  public async deleteTopic(topic: string): Promise<void> {
    await this.withAdmin(`delete topic "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      await admin.deleteTopics({ topics: [topic] });
    });
  }

  public async addPartitions(topic: string, count: number): Promise<void> {
    await this.withAdmin(`add partitions to "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      const current = metadata.topics[0]?.partitions.length ?? 0;
      if (count <= current) {
        throw new ResourceConflictError(
          `Topic "${topic}" already has ${current} partitions; Kafka can only increase the count, never reduce it`,
        );
      }
      await admin.createPartitions({ topicPartitions: [{ topic, count }] });
    });
  }

  public async alterTopicConfigs(topic: string, changes: Readonly<Record<string, string | null>>): Promise<void> {
    await this.withAdmin(`alter configs of "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      // kafkajs speaks the legacy AlterConfigs API, which REPLACES the whole
      // override set: an entry not sent is reset to the broker default. So
      // the current overrides are read first and the change merged into them —
      // sending only the edited key would silently wipe every other override.
      const current = await this.readTopicConfigs(admin, topic);
      const overrides = current.filter((entry) => entry.source === "TOPIC_CONFIG");
      if (overrides.some((entry) => entry.isSensitive)) {
        throw new ResourceConflictError(
          `Topic "${topic}" has a sensitive config override whose value the broker does not return; ` +
            "altering configs here would reset it, so edit it with the Kafka CLI instead",
        );
      }
      const merged = new Map(overrides.map((entry) => [entry.name, entry.value as string]));
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) merged.delete(name);
        else merged.set(name, value);
      }
      await admin.alterConfigs({
        validateOnly: false,
        resources: [
          {
            type: TOPIC_CONFIG_RESOURCE,
            name: topic,
            configEntries: [...merged].map(([name, value]) => ({ name, value })),
          },
        ],
      });
    });
  }

  /**
   * Resolve each selected partition's start offset for a seek. The offsets
   * are clamped into [low, high]: a seek below the log start or past the end
   * reads what exists instead of erroring on a retention race.
   */
  private async seekStarts(
    admin: KafkaAdmin,
    topic: string,
    seek: KafkaSeek,
    partitions: ReadonlyArray<{ partition: number; low: bigint; high: bigint }>,
  ): Promise<Map<number, bigint>> {
    const starts = new Map<number, bigint>();
    if (seek.mode === "timestamp") {
      const byTime = await admin.fetchTopicOffsetsByTimestamp(topic, seek.timestamp);
      for (const entry of partitions) {
        const found = byTime.find((candidate) => candidate.partition === entry.partition);
        // "-1": no record at or after the timestamp — nothing to read there.
        const offset = found === undefined || found.offset === "-1" ? entry.high : BigInt(found.offset);
        starts.set(entry.partition, clampOffset(offset, entry.low, entry.high));
      }
      return starts;
    }
    for (const entry of partitions) {
      const start = seek.mode === "offset" ? clampOffset(BigInt(seek.offset), entry.low, entry.high) : entry.low;
      starts.set(entry.partition, start);
    }
    return starts;
  }

  public async readMessages(topic: string, query: KafkaReadQuery): Promise<KafkaMessagesPage> {
    const limit = Math.max(1, Math.min(query.limit, KAFKA_READ_LIMIT));
    const tail = query.seek.mode === "latest";
    const plan = await this.withAdmin(`read "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      const offsets = (await admin.fetchTopicOffsets(topic))
        .filter((entry) => query.partition === undefined || entry.partition === query.partition)
        .map((entry) => ({ partition: entry.partition, low: BigInt(entry.low), high: BigInt(entry.high) }))
        .sort((a, b) => a.partition - b.partition);
      if (offsets.length === 0) {
        throw new ResourceNotFoundError(`Topic "${topic}" has no partition ${query.partition}`);
      }
      const starts = await this.seekStarts(admin, topic, query.seek, offsets);
      // The window is snapshotted against the high watermark NOW: a read never
      // waits for arrivals, so a quiet topic answers at once instead of at the
      // deadline.
      const available = offsets.map((entry) =>
        Number(tail ? entry.high - entry.low : entry.high - (starts.get(entry.partition) as bigint)),
      );
      const quotas = allocateReadQuotas(
        available.map((count) => Math.min(count, limit)),
        limit,
      );
      const windows: ReadWindow[] = offsets.flatMap((entry, index) => {
        const quota = BigInt(quotas[index]);
        if (quota === BigInt(0)) return [];
        const start = tail ? entry.high - quota : (starts.get(entry.partition) as bigint);
        return [{ partition: entry.partition, start, end: start + quota }];
      });
      const total = available.reduce((sum, count) => sum + count, 0);
      return { windows, total };
    });
    if (plan.windows.length === 0) return { messages: [], truncated: false };

    const kafka = await this.getKafka();
    const groupId = `${KAFKA_PEEK_GROUP_PREFIX}${this.config.id}-${Date.now()}`;
    const collected: KafkaRecord[] = [];
    try {
      const consumer = kafka.consumer({ groupId });
      await consumer.connect();
      try {
        const pending = new Map(plan.windows.map((window) => [window.partition, window]));
        let bytes = 0;
        let budgetSpent = false;
        // A fresh group with fromBeginning:false starts every partition at its
        // end, so partitions outside the plan fetch nothing; the planned ones
        // are moved to their window start by the seeks below.
        await consumer.subscribe({ topic, fromBeginning: false });
        await consumer.run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            const window = pending.get(partition);
            if (window === undefined || budgetSpent) return;
            const offset = BigInt(message.offset);
            if (offset < window.start) return;
            if (offset < window.end) {
              const key = decodeBytes(message.key, KAFKA_VALUE_MAX_BYTES);
              const value = decodeBytes(message.value, KAFKA_VALUE_MAX_BYTES);
              collected.push({
                partition,
                offset: message.offset,
                timestamp: message.timestamp,
                key: key.text,
                value: value.text,
                keyEncoding: key.encoding,
                valueEncoding: value.encoding,
                valueTruncated: value.truncated,
                valueBytes: value.size,
                headers: decodeHeaders(message.headers),
              });
              bytes += Math.min(key.size, KAFKA_VALUE_MAX_BYTES) + Math.min(value.size, KAFKA_VALUE_MAX_BYTES);
              if (bytes >= KAFKA_READ_BYTE_BUDGET) budgetSpent = true;
            }
            // Done at the window's last offset — or past it, when compaction
            // or a transaction marker took that exact offset away.
            if (offset >= window.end - BigInt(1)) pending.delete(partition);
            // Not awaited: the browse ruling (stop waits for this very handler).
            if (pending.size === 0 || budgetSpent) void consumer.stop().catch(() => undefined);
          },
        });
        for (const window of plan.windows) {
          consumer.seek({ topic, partition: window.partition, offset: window.start.toString() });
        }
        const deadline = Date.now() + KAFKA_BROWSE_TIMEOUT_MS;
        // A function, not the bare flags: the handler mutates them from outside this loop.
        const finished = () => pending.size === 0 || budgetSpent;
        while (!finished() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await consumer.stop().catch(() => undefined);
        await consumer.disconnect().catch(() => undefined);
      }
    } catch (error) {
      throw translateKafkaError(error, `read "${topic}"`);
    }
    // Best effort: the group committed nothing, but it would still show in
    // the consumer-group list until the broker expires it.
    await this.withAdmin("clean up peek group", (admin) => admin.deleteGroups([groupId])).catch(() => undefined);

    collected.sort(compareRecords);
    if (tail) collected.reverse();
    return { messages: collected, truncated: plan.total > collected.length };
  }

  public async produceMessage(topic: string, input: KafkaProduceInput): Promise<KafkaProduceResult> {
    // Existence first: on a broker with auto.create.topics.enable, producing
    // to a typo would CREATE the typo. The listing refuses it instead.
    await this.withAdmin(`produce to "${topic}"`, (admin) => this.requireTopic(admin, topic));
    try {
      const kafka = await this.getKafka();
      const producer = kafka.producer();
      await producer.connect();
      try {
        const [metadata] = await producer.send({
          topic,
          messages: [
            {
              value: input.value,
              ...(input.key !== undefined ? { key: input.key } : {}),
              ...(input.partition !== undefined ? { partition: input.partition } : {}),
              ...(input.headers !== undefined ? { headers: { ...input.headers } } : {}),
            },
          ],
        });
        return { partition: metadata.partition, offset: metadata.baseOffset ?? metadata.offset ?? "-1" };
      } finally {
        await producer.disconnect().catch(() => undefined);
      }
    } catch (error) {
      throw translateKafkaError(error, `produce to "${topic}"`);
    }
  }

  /**
   * End offsets per topic, cached as a promise with the failure included: a
   * topic whose end offsets cannot be read (deleted since the group
   * committed, leaderless) costs its own rows their lag, never the group's
   * other topics, and a topic ten groups consumed is asked for — and failed —
   * once, even while those groups are measured concurrently. `ttlMs` null
   * keeps entries for the cache's own lifetime.
   */
  private endOffsetReader(cache: Map<string, { at: number; ends: EndOffsets }>, ttlMs: number | null): EndOffsetReader {
    return (admin, topic) => {
      const cached = cache.get(topic);
      if (cached !== undefined && (ttlMs === null || Date.now() - cached.at < ttlMs)) return cached.ends;
      const ends: EndOffsets = admin.fetchTopicOffsets(topic).then(
        (entries) => new Map(entries.map((entry) => [entry.partition, entry.high])),
        (error: unknown) => reasonOf(error),
      );
      cache.set(topic, { at: Date.now(), ends });
      return ends;
    };
  }

  /** Lag batches share end offsets for `endOffsetTtlMs`: a sweep over every group re-reads a topic only as often. */
  private readonly sharedEndOffsets = new Map<string, { at: number; ends: EndOffsets }>();

  /** Committed offsets and end offsets joined into per-partition lag. */
  private async groupOffsets(admin: KafkaAdmin, groupId: string, endsOf: EndOffsetReader): Promise<KafkaGroupOffset[]> {
    const committed = await admin.fetchOffsets({ groupId });
    const rows: KafkaGroupOffset[] = [];
    for (const { topic, partitions } of committed) {
      const ends = await endsOf(admin, topic);
      for (const { partition, offset } of partitions) {
        // "-1": the group never committed on this partition.
        const committedOffset = offset === "-1" ? null : offset;
        if (typeof ends === "string") {
          rows.push({ topic, partition, committedOffset, endOffset: null, lag: null, endOffsetError: ends });
          continue;
        }
        const endOffset = ends.get(partition) ?? "0";
        rows.push({
          topic,
          partition,
          committedOffset,
          endOffset,
          lag: committedOffset === null ? null : Math.max(0, Number(BigInt(endOffset) - BigInt(committedOffset))),
          endOffsetError: null,
        });
      }
    }
    return rows.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
  }

  /** State and members for every group; lag is `measureGroupLag`'s, asked for by the rows on screen. */
  public async listConsumerGroups(): Promise<KafkaConsumerGroupListing> {
    return this.withAdmin("list consumer groups", async (admin) => {
      const { groups } = await admin.listGroups();
      const ids = groups.map((group) => group.groupId).sort((a, b) => a.localeCompare(b));
      if (ids.length === 0) return { groups: [] };
      const described = await admin.describeGroups(ids);
      const byId = new Map(described.groups.map((group) => [group.groupId, group]));
      const coordinatorOf = await this.groupCoordinators(admin);
      return {
        groups: ids.map((id) => {
          const group = byId.get(id);
          return {
            groupId: id,
            state: group?.state ?? "Unknown",
            protocolType: group?.protocolType ?? "",
            protocol: group?.protocol ?? "",
            members: group?.members.length ?? 0,
            coordinator: coordinatorOf(id),
            internal: id.startsWith(KAFKA_PEEK_GROUP_PREFIX),
          };
        }),
      };
    });
  }

  /**
   * Every group's coordinator from ONE metadata read. kafkajs finds each
   * group's coordinator inside describeGroups and throws the answer away, and
   * asking again (FindCoordinator) would cost a request per group. Kafka
   * assigns it deterministically instead — the leader of the
   * `__consumer_offsets` partition the id hashes to — so that is what this
   * reads. Best effort: unreadable metadata answers null for every group.
   */
  private async groupCoordinators(admin: KafkaAdmin): Promise<(groupId: string) => number | null> {
    let leaders: Map<number, number>;
    try {
      const { topics } = await admin.fetchTopicMetadata({ topics: [GROUP_OFFSETS_TOPIC] });
      leaders = new Map((topics[0]?.partitions ?? []).map((partition) => [partition.partitionId, partition.leader]));
    } catch {
      return () => null;
    }
    return (groupId) => {
      if (leaders.size === 0) return null;
      const leader = leaders.get(groupOffsetsPartition(groupId, leaders.size));
      return leader === undefined || leader < 0 ? null : leader;
    };
  }

  /**
   * Total lag for a bounded batch of groups, a few in flight at a time; end
   * offsets are shared across the batch, so a topic consumed by ten groups is
   * read once — and across batches for `endOffsetTtlMs`, so a sweep over
   * every group stays close to one read per topic. Per group, best effort: one group's unreadable offsets answer
   * as that group's `lagError`, never as a failed batch — and a total over a
   * partial set would read as the real lag, so it is null instead.
   */
  public async measureGroupLag(groupIds: readonly string[]): Promise<Record<string, KafkaGroupLag>> {
    const ids = boundedBatch(groupIds, "consumer groups");
    if (ids.length === 0) return {};
    return this.withAdmin("measure consumer group lag", async (admin) => {
      const endsOf = this.endOffsetReader(this.sharedEndOffsets, endOffsetTtlMs);
      const lags = await mapBoundedWithDeadline(
        ids,
        KAFKA_OFFSET_CONCURRENCY,
        async (id): Promise<KafkaGroupLag> => {
          try {
            const rows = await this.groupOffsets(admin, id, endsOf);
            const topics = new Set(rows.filter((row) => row.committedOffset !== null).map((row) => row.topic)).size;
            const unreadable = rows.find((row) => row.endOffsetError !== null);
            return unreadable === undefined
              ? { totalLag: rows.reduce((sum, row) => sum + (row.lag ?? 0), 0), lagError: null, topics }
              : { totalLag: null, lagError: `${unreadable.topic}: ${unreadable.endOffsetError}`, topics };
          } catch (error) {
            return { totalLag: null, lagError: reasonOf(error), topics: null };
          }
        },
        () => ({ totalLag: null, lagError: deadlineReason(), topics: null }),
      );
      return Object.fromEntries(ids.map((id, index) => [id, lags[index]]));
    });
  }

  public async describeConsumerGroup(groupId: string): Promise<KafkaConsumerGroupDetail> {
    const sdk = await loadKafka();
    return this.withAdmin(`describe group "${groupId}"`, async (admin) => {
      const [group] = (await admin.describeGroups([groupId])).groups;
      const offsets = await this.groupOffsets(admin, groupId, this.endOffsetReader(new Map(), null));
      // A group the coordinator does not know describes as "Dead" with no
      // members; with no committed offsets either, it simply does not exist.
      if (group === undefined || (group.state === "Dead" && offsets.length === 0)) {
        throw new ResourceNotFoundError(`Consumer group "${groupId}" does not exist`);
      }
      const members: KafkaGroupMember[] = group.members.map((member) => {
        let assignments: KafkaGroupMember["assignments"] = [];
        try {
          // Only the "consumer" protocol carries a decodable assignment; a
          // Connect worker or a non-Java client may not.
          const decoded = sdk.AssignerProtocol.MemberAssignment.decode(member.memberAssignment);
          assignments = Object.entries(decoded?.assignment ?? {})
            .map(([topic, partitions]) => ({ topic, partitions: [...partitions].sort((a, b) => a - b) }))
            .sort((a, b) => a.topic.localeCompare(b.topic));
        } catch {
          assignments = [];
        }
        return { memberId: member.memberId, clientId: member.clientId, clientHost: member.clientHost, assignments };
      });
      return {
        groupId,
        state: group.state,
        protocolType: group.protocolType,
        protocol: group.protocol,
        members,
        offsets,
      };
    });
  }

  /** The group must exist and be Empty: offsets of a group with live members are theirs to commit. */
  private async requireEmptyGroup(admin: KafkaAdmin, groupId: string, action: string): Promise<void> {
    const [group] = (await admin.describeGroups([groupId])).groups;
    const committed = await admin.fetchOffsets({ groupId });
    if (group === undefined || (group.state === "Dead" && committed.length === 0)) {
      throw new ResourceNotFoundError(`Consumer group "${groupId}" does not exist`);
    }
    if (group.state !== "Empty" && group.state !== "Dead") {
      throw new ResourceConflictError(
        `Cannot ${action} consumer group "${groupId}" while it is ${group.state} with ${group.members.length} ` +
          "active member(s): stop every consumer in the group first, then retry once it reports Empty",
      );
    }
  }

  public async resetConsumerGroupOffsets(input: KafkaResetOffsetsInput): Promise<readonly KafkaGroupOffset[]> {
    const { groupId, topic, reset } = input;
    return this.withAdmin(`reset offsets of "${groupId}" on "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      await this.requireEmptyGroup(admin, groupId, "reset offsets of");
      const watermarks = (await admin.fetchTopicOffsets(topic))
        .filter((entry) => input.partitions === undefined || input.partitions.includes(entry.partition))
        .map((entry) => ({ partition: entry.partition, low: BigInt(entry.low), high: BigInt(entry.high) }));
      if (watermarks.length === 0) {
        throw new ResourceNotFoundError(`Topic "${topic}" has none of partitions ${input.partitions?.join(", ")}`);
      }
      let targets: Map<number, bigint>;
      if (reset.mode === "earliest" || reset.mode === "latest") {
        targets = new Map(
          watermarks.map((entry) => [entry.partition, reset.mode === "earliest" ? entry.low : entry.high]),
        );
      } else {
        const seek: KafkaSeek = reset.mode === "offset" ? { mode: "offset", offset: reset.offset } : reset;
        targets = await this.seekStarts(admin, topic, seek, watermarks);
      }
      const partitions = watermarks.map((entry) => ({
        partition: entry.partition,
        offset: (targets.get(entry.partition) as bigint).toString(),
      }));
      await admin.setOffsets({ groupId, topic, partitions });
      return watermarks.map((entry) => {
        const committedOffset = (targets.get(entry.partition) as bigint).toString();
        return {
          topic,
          partition: entry.partition,
          committedOffset,
          endOffset: entry.high.toString(),
          lag: Number(entry.high - BigInt(committedOffset)),
          endOffsetError: null,
        };
      });
    });
  }

  public async deleteConsumerGroup(groupId: string): Promise<void> {
    await this.withAdmin(`delete group "${groupId}"`, async (admin) => {
      await this.requireEmptyGroup(admin, groupId, "delete");
      await admin.deleteGroups([groupId]);
    });
  }
}

/** De-duplicated names for one lazy-measurement call; past the batch bound is the caller's mistake (400). */
function boundedBatch(names: readonly string[], noun: string): string[] {
  const unique = [...new Set(names)];
  if (unique.length > KAFKA_MEASURE_BATCH_LIMIT) {
    throw new ResourceInvalidRequestError(`At most ${KAFKA_MEASURE_BATCH_LIMIT} ${noun} can be measured per request`);
  }
  return unique;
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
