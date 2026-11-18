import {
  KAFKA_MEASURE_BATCH_LIMIT,
  type KafkaAdminOperations,
  type KafkaClusterOverview,
  type KafkaConfigEntry,
  type KafkaConsumerGroupDetail,
  type KafkaConsumerGroupListing,
  type KafkaCreateTopicInput,
  type KafkaGroupLag,
  type KafkaGroupOffset,
  type KafkaMessagesPage,
  type KafkaOffsetReset,
  type KafkaProduceInput,
  type KafkaProduceResult,
  type KafkaReadQuery,
  type KafkaRecord,
  type KafkaResetOffsetsInput,
  type KafkaSeek,
  type KafkaTopicCount,
  type KafkaTopicDetail,
  type KafkaTopicListing,
} from "../../operations";
import {
  ResourceConflictError,
  ResourceConnectionError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
} from "../../errors";
import {
  createKafkaWire,
  forkKafkaConnectionOptions,
  loadForkKafka,
  type ForkKafkaLibrary,
  type KafkaConnectionConfig,
  type KafkaWire,
  type LibConfigEntry,
  type LibGroupOffsets,
  type LibMessage,
  type LibMetadata,
} from "./kafka-client";

/**
 * The fork's write-capable Kafka workbench provider (REFORK_ANALYSIS 5.4). It
 * implements the shared `KafkaAdminOperations` surface with the library's FULL
 * Admin/Producer/Consumer APIs, over an UPSTREAM `kafka` connection record
 * resolved server-side by the routes — there is no second fork connection
 * record. Reads are bounded and best effort; writes carry the typed refusals
 * the routes turn into `SB_*` answers.
 *
 * All library access goes through an injected `KafkaWire` (a test passes a
 * fake), so this module owns the mapping and the policy, and the SDK stays in
 * `kafka-client.ts` alone.
 */

const TOPIC_RESOURCE_TYPE = 2;
const CONFIG_SET = 0;
const CONFIG_DELETE = 1;
const DEFAULT_CONFIG_SOURCE = 5;
const EARLIEST = BigInt(-2);
const LATEST = BigInt(-1);
const READ_UNCOMMITTED = 0;
const INVALID_TYPES = new Set([
  "INVALID_REPLICATION_FACTOR",
  "INVALID_PARTITIONS",
  "INVALID_CONFIG",
  "INVALID_TOPIC_EXCEPTION",
  "INVALID_REPLICA_ASSIGNMENT",
  "POLICY_VIOLATION",
  "INVALID_REQUEST",
]);
const CONFLICT_TYPES = new Set(["TOPIC_ALREADY_EXISTS", "NON_EMPTY_GROUP", "REBALANCE_IN_PROGRESS"]);
const NOT_FOUND_TYPES = new Set(["UNKNOWN_TOPIC_OR_PARTITION", "GROUP_ID_NOT_FOUND"]);
const SOURCE_NAMES: Readonly<Record<number, string>> = {
  0: "UNKNOWN",
  1: "TOPIC_CONFIG",
  2: "DYNAMIC_BROKER_CONFIG",
  3: "DYNAMIC_DEFAULT_BROKER_CONFIG",
  4: "STATIC_BROKER_CONFIG",
  5: "DEFAULT_CONFIG",
  6: "DYNAMIC_BROKER_LOGGER_CONFIG",
};
const VALUE_MAX_BYTES = 64 * 1024;
const READ_BYTE_BUDGET = 8 * 1024 * 1024;
const PEEK_GROUP_PREFIX = "storagebase-peek-";

/** A protocol error code carried anywhere in a library failure's chain. */
function apiIdOf(error: unknown): string | undefined {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 6) return;
    const shaped = value as { apiId?: unknown; code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof shaped.apiId === "string") found.push(shaped.apiId);
    const nested = Array.isArray(shaped.errors) ? shaped.errors : [shaped.cause];
    for (const entry of nested) walk(entry, depth + 1);
  };
  walk(error, 0);
  return found[0];
}

function sentenceOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Broker refusals keep their typed meaning; everything else is a connection failure. */
function translate(error: unknown, what: string): Error {
  if (
    error instanceof ResourceConflictError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ResourceInvalidRequestError ||
    error instanceof ResourceConnectionError
  ) {
    return error;
  }
  const id = apiIdOf(error);
  const sentence = `Kafka ${what}: ${id ?? sentenceOf(error)}`;
  if (id !== undefined && INVALID_TYPES.has(id)) return new ResourceInvalidRequestError(sentence);
  if (id !== undefined && CONFLICT_TYPES.has(id)) return new ResourceConflictError(sentence);
  if (id !== undefined && NOT_FOUND_TYPES.has(id)) return new ResourceNotFoundError(sentence);
  return new ResourceConnectionError(sentence);
}

function boundedBatch(names: readonly string[], noun: string): string[] {
  const unique = [...new Set(names)];
  if (unique.length > KAFKA_MEASURE_BATCH_LIMIT) {
    throw new ResourceInvalidRequestError(`At most ${KAFKA_MEASURE_BATCH_LIMIT} ${noun} can be measured per request`);
  }
  return unique;
}

/** Bytes to clean UTF-8 text, base64 when binary, cut and flagged past the cap. */
function decodeBytes(bytes: Uint8Array | null): {
  text: string | null;
  encoding: "utf8" | "base64";
  truncated: boolean;
  size: number;
} {
  if (bytes === null) return { text: null, encoding: "utf8", truncated: false, size: 0 };
  const truncated = bytes.length > VALUE_MAX_BYTES;
  const slice = truncated ? bytes.subarray(0, VALUE_MAX_BYTES) : bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice, { stream: truncated });
    return { text, encoding: "utf8", truncated, size: bytes.length };
  } catch {
    return { text: Buffer.from(slice).toString("base64"), encoding: "base64", truncated, size: bytes.length };
  }
}

function decodeHeaders(headers: ReadonlyMap<Uint8Array, Uint8Array>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [name, value] of headers) {
    decoded[new TextDecoder().decode(name)] = new TextDecoder().decode(value);
  }
  return decoded;
}

function compareRecords(a: KafkaRecord, b: KafkaRecord): number {
  const byTime = Number(a.timestamp) - Number(b.timestamp);
  if (byTime !== 0) return byTime;
  if (a.partition !== b.partition) return a.partition - b.partition;
  return Number(BigInt(a.offset) - BigInt(b.offset));
}

function mapConfig(entry: LibConfigEntry): KafkaConfigEntry {
  return {
    name: entry.name,
    value: entry.isSensitive ? null : entry.value,
    source: SOURCE_NAMES[entry.configSource] ?? "UNKNOWN",
    isDefault: entry.isDefault || entry.configSource === DEFAULT_CONFIG_SOURCE,
    readOnly: entry.readOnly,
    isSensitive: entry.isSensitive,
  };
}

export interface KafkaProviderOptions {
  /** A test injects a fake wire; production builds one from `config` on first use. */
  readonly wire?: KafkaWire;
  /** A test injects the library loader so no real SDK import happens. */
  readonly load?: () => Promise<ForkKafkaLibrary>;
  readonly timeoutMs?: number;
}

export class KafkaProvider implements KafkaAdminOperations {
  private wire: KafkaWire | null;
  private readonly load: () => Promise<ForkKafkaLibrary>;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: KafkaConnectionConfig,
    options: KafkaProviderOptions = {},
  ) {
    this.wire = options.wire ?? null;
    this.load = options.load ?? (() => loadForkKafka());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async getWire(): Promise<KafkaWire> {
    if (this.wire === null) {
      const options = forkKafkaConnectionOptions(this.config, this.timeoutMs);
      this.wire = createKafkaWire(options, await this.load());
    }
    return this.wire;
  }

  /** Run one admin call, always in the fork's error vocabulary. */
  private async withAdmin<T>(what: string, run: (admin: KafkaWire["admin"]) => Promise<T>): Promise<T> {
    try {
      return await run((await this.getWire()).admin);
    } catch (error) {
      throw translate(error, what);
    }
  }

  private async requireTopic(admin: KafkaWire["admin"], topic: string): Promise<void> {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) throw new ResourceNotFoundError(`Topic "${topic}" does not exist`);
  }

  /** Partition counts for a topic, or for every listed topic when no name is given. */
  private async partitionsOf(admin: KafkaWire["admin"], names?: readonly string[]): Promise<Map<string, number[]>> {
    const metadata = await admin.metadata({
      topics: names === undefined ? [] : [...names],
      autocreateTopics: false,
      ...(names === undefined ? { forceUpdate: true } : {}),
    });
    return new Map([...metadata.topics].map(([name, topic]) => [name, topic.partitions.map((_, index) => index)]));
  }

  /** High and low watermarks by partition (two ListOffsets reads with the protocol's sentinels). */
  private async watermarks(
    admin: KafkaWire["admin"],
    topic: string,
    partitions: readonly number[],
  ): Promise<Map<number, { low: bigint; high: bigint }>> {
    const request = (timestamp: bigint) => ({
      topics: [{ name: topic, partitions: partitions.map((partitionIndex) => ({ partitionIndex, timestamp })) }],
      isolationLevel: READ_UNCOMMITTED,
    });
    const [highAnswer, lowAnswer] = await Promise.all([
      admin.listOffsets(request(LATEST)),
      admin.listOffsets(request(EARLIEST)),
    ]);
    const entries = (topicAnswer: (typeof highAnswer)[number] | undefined) =>
      new Map((topicAnswer?.partitions ?? []).map((part) => [part.partitionIndex, part.offset]));
    const high = entries(highAnswer.find((t) => t.name === topic));
    const low = entries(lowAnswer.find((t) => t.name === topic));
    return new Map(
      partitions.map((partition) => [
        partition,
        { low: low.get(partition) ?? BigInt(0), high: high.get(partition) ?? BigInt(0) },
      ]),
    );
  }

  public async describeCluster(): Promise<KafkaClusterOverview> {
    return this.withAdmin("describe cluster", async (admin) => {
      const metadata: LibMetadata = await admin.metadata({ topics: [], autocreateTopics: false, forceUpdate: true });
      return {
        clusterId: metadata.clusterId,
        controllerId: metadata.controllerId,
        brokers: [...metadata.brokers.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([nodeId, broker]) => ({
            nodeId,
            host: broker.host,
            port: broker.port,
            rack: broker.rack,
            isController: nodeId === metadata.controllerId,
          })),
      };
    });
  }

  public async listTopicSummaries(): Promise<KafkaTopicListing> {
    return this.withAdmin("list topics", async (admin) => {
      const names = (await admin.listTopics()).filter((name) => !name.startsWith("__"));
      const metadata = await admin.metadata({ topics: names, autocreateTopics: false });
      const topics = names.map((name) => {
        const parts = metadata.topics.get(name)?.partitions ?? [];
        return {
          name,
          internal: name.startsWith("__"),
          partitions: parts.length,
          replicationFactor: Math.max(0, ...parts.map((part) => part.replicas.length)),
          underReplicatedPartitions: parts.filter((part) => part.isr.length < part.replicas.length).length,
        };
      });
      return { topics: topics.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }

  public async countTopicMessages(topics: readonly string[]): Promise<Record<string, KafkaTopicCount>> {
    const names = boundedBatch(topics, "topics");
    if (names.length === 0) return {};
    return this.withAdmin("count topic messages", async (admin) => {
      const partitions = await this.partitionsOf(admin, names);
      const result: Record<string, KafkaTopicCount> = {};
      for (const name of names) {
        const parts = partitions.get(name);
        if (parts === undefined || parts.length === 0) {
          result[name] = { messageCount: null, countError: "topic does not exist or has no partitions" };
          continue;
        }
        try {
          const marks = await this.watermarks(admin, name, parts);
          result[name] = {
            messageCount: [...marks.values()].reduce((sum, mark) => sum + Number(mark.high - mark.low), 0),
            countError: null,
          };
        } catch (error) {
          result[name] = { messageCount: null, countError: sentenceOf(error) };
        }
      }
      return result;
    });
  }

  public async describeTopic(topic: string): Promise<KafkaTopicDetail> {
    return this.withAdmin(`describe "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      const metadata = await admin.metadata({ topics: [topic], autocreateTopics: false });
      const parts = metadata.topics.get(topic)?.partitions ?? [];
      let offsetsError: string | null = parts.length === 0 ? "no partition metadata" : null;
      let marks = new Map<number, { low: bigint; high: bigint }>();
      if (offsetsError === null) {
        try {
          marks = await this.watermarks(
            admin,
            topic,
            parts.map((_, index) => index),
          );
        } catch (error) {
          offsetsError = sentenceOf(error);
        }
      }
      const configs = await admin.describeConfigs({
        resources: [{ resourceType: TOPIC_RESOURCE_TYPE, resourceName: topic }],
        includeSynonyms: false,
      });
      const entries = configs.find((resource) => resource.resourceName === topic)?.configs ?? [];
      return {
        name: topic,
        internal: topic.startsWith("__"),
        partitions: parts.map((part, partition) => ({
          partition,
          leader: part.leader,
          replicas: part.replicas,
          isr: part.isr,
          offlineReplicas: part.offlineReplicas,
          earliestOffset: marks.get(partition)?.low.toString() ?? null,
          latestOffset: marks.get(partition)?.high.toString() ?? null,
        })),
        configs: [...entries].map(mapConfig).sort((a, b) => a.name.localeCompare(b.name)),
        offsetsError,
      };
    });
  }

  public async createTopic(input: KafkaCreateTopicInput): Promise<void> {
    await this.withAdmin(`create topic "${input.name}"`, async (admin) => {
      const created = await admin.createTopics({
        topics: [
          {
            topic: input.name,
            partitions: input.partitions,
            replicas: input.replicationFactor,
            ...(input.configs === undefined
              ? {}
              : {
                  configs: Object.entries(input.configs).map(([name, value]) => ({ name, value })),
                }),
          },
        ],
      });
      if (Array.isArray(created) && created.length === 0) {
        throw new ResourceConflictError(`Topic "${input.name}" already exists`);
      }
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
      const partitions = await this.partitionsOf(admin, [topic]);
      const current = partitions.get(topic)?.length ?? 0;
      if (count <= current) {
        throw new ResourceConflictError(
          `Topic "${topic}" already has ${current} partitions; Kafka can only increase the count`,
        );
      }
      await admin.createPartitions({ topics: [{ topic, count }] });
    });
  }

  public async alterTopicConfigs(topic: string, changes: Readonly<Record<string, string | null>>): Promise<void> {
    await this.withAdmin(`alter configs of "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      // IncrementalAlterConfigs changes only the named keys: no need to re-send
      // the current override set (the legacy kafkajs path had to, and could wipe it).
      const configs = Object.entries(changes).map(([name, value]) =>
        value === null ? { name, configOperation: CONFIG_DELETE } : { name, configOperation: CONFIG_SET, value },
      );
      await admin.incrementalAlterConfigs({
        resources: [{ resourceType: TOPIC_RESOURCE_TYPE, resourceName: topic, configs }],
        validateOnly: false,
      });
    });
  }

  public async readMessages(topic: string, query: KafkaReadQuery): Promise<KafkaMessagesPage> {
    const limit = Math.max(1, Math.min(query.limit, 200));
    const wire = await this.getWire();
    const admin = wire.admin;
    const plan = await this.withAdmin(`read "${topic}"`, async () => {
      await this.requireTopic(admin, topic);
      const partitions = await this.partitionsOf(admin, [topic]);
      const parts = partitions.get(topic) ?? [];
      const chosen = query.partition === undefined ? parts : parts.filter((part) => part === query.partition);
      if (chosen.length === 0) throw new ResourceNotFoundError(`Topic "${topic}" has no partition ${query.partition}`);
      const marks = await this.watermarks(admin, topic, chosen);
      const starts = await this.seekStarts(admin, topic, query.seek, chosen, marks);
      const windows = chosen.map((partition) => {
        const start =
          query.seek.mode === "latest"
            ? (marks.get(partition)?.high ?? BigInt(0))
            : (starts.get(partition) ?? BigInt(0));
        const end = marks.get(partition)?.high ?? BigInt(0);
        return { partition, offset: start, remaining: end > start ? Number(end - start) : 0 };
      });
      const total = windows.reduce((sum, window) => sum + window.remaining, 0);
      return windows
        .map((window) => ({ ...window, limitShare: Math.max(1, Math.floor(limit / windows.length)) }))
        .slice(0, total === 0 ? 0 : windows.length);
    });
    if (plan.length === 0) return { messages: [], truncated: false };

    const groupId = `${PEEK_GROUP_PREFIX}${Date.now()}`;
    const consumer = wire.newConsumer(groupId);
    const collected: KafkaRecord[] = [];
    let bytes = 0;
    try {
      // One stream over the planned offsets; the byte and count bounds stop it.
      const stream = await consumer.consume({
        topics: [topic],
        autocommit: false,
        mode: "earliest",
        offsets: plan.map((window) => ({ topic, partition: window.partition, offset: window.offset })),
      });
      for await (const message of stream) {
        if (collected.length >= limit || bytes >= READ_BYTE_BUDGET) break;
        const key = decodeBytes(message.key);
        const value = decodeBytes(message.value);
        collected.push({
          partition: message.partition,
          offset: message.offset.toString(),
          timestamp: message.timestamp.toString(),
          key: key.text,
          value: value.text,
          keyEncoding: key.encoding,
          valueEncoding: value.encoding,
          valueTruncated: value.truncated,
          valueBytes: value.size,
          headers: decodeHeaders(message.headers),
        });
        bytes += key.size + value.size;
      }
      await stream.close();
    } finally {
      await consumer.close();
    }
    await this.withAdmin("clean up peek group", (admin) => admin.deleteGroups([groupId])).catch(() => undefined);
    collected.sort(compareRecords);
    if (query.seek.mode === "latest") collected.reverse();
    return {
      messages: collected,
      truncated: plan.reduce((sum, window) => sum + window.remaining, 0) > collected.length,
    };
  }

  /** Start offsets for a seek, clamped into [low, high]. */
  private async seekStarts(
    admin: KafkaWire["admin"],
    topic: string,
    seek: KafkaSeek,
    partitions: readonly number[],
    marks: ReadonlyMap<number, { low: bigint; high: bigint }>,
  ): Promise<Map<number, bigint>> {
    const starts = new Map<number, bigint>();
    let byTime: Map<number, bigint> | null = null;
    if (seek.mode === "timestamp") {
      const answer = await admin.listOffsets({
        topics: [
          {
            name: topic,
            partitions: partitions.map((partitionIndex) => ({ partitionIndex, timestamp: BigInt(seek.timestamp) })),
          },
        ],
        isolationLevel: READ_UNCOMMITTED,
      });
      const topicAnswer = answer.find((entry) => entry.name === topic);
      byTime = new Map((topicAnswer?.partitions ?? []).map((part) => [part.partitionIndex, part.offset]));
    }
    for (const partition of partitions) {
      const mark = marks.get(partition) ?? { low: BigInt(0), high: BigInt(0) };
      const wanted =
        seek.mode === "earliest"
          ? mark.low
          : seek.mode === "latest"
            ? mark.high
            : seek.mode === "offset"
              ? BigInt(seek.offset)
              : (byTime?.get(partition) ?? mark.high);
      const clamped = wanted < mark.low ? mark.low : wanted > mark.high ? mark.high : wanted;
      starts.set(partition, clamped);
    }
    return starts;
  }

  public async produceMessage(topic: string, input: KafkaProduceInput): Promise<KafkaProduceResult> {
    await this.withAdmin(`produce to "${topic}"`, (admin) => this.requireTopic(admin, topic));
    try {
      const answer = await (await this.getWire()).producer.send({
        topic,
        messages: [
          {
            value: input.value,
            ...(input.key === undefined ? {} : { key: input.key }),
            ...(input.partition === undefined ? {} : { partition: input.partition }),
            ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
          },
        ],
      });
      const first = answer[0];
      return { partition: first?.partition ?? 0, offset: first?.baseOffset?.toString() ?? "-1" };
    } catch (error) {
      throw translate(error, `produce to "${topic}"`);
    }
  }

  /** Committed offsets joined with a topic's end offsets into per-partition lag rows. */
  private async groupOffsets(
    admin: KafkaWire["admin"],
    groupId: string,
    ends: ReadonlyMap<string, Map<number, bigint>>,
  ): Promise<KafkaGroupOffset[]> {
    const answer = (await admin.listConsumerGroupOffsets({ groups: [groupId] })).find((g) => g.groupId === groupId);
    const rows: KafkaGroupOffset[] = [];
    for (const topic of answer?.topics ?? []) {
      for (const part of topic.partitions) {
        const committed = part.committedOffset < BigInt(0) ? null : part.committedOffset;
        const end = ends.get(topic.name)?.get(part.partitionIndex);
        rows.push({
          topic: topic.name,
          partition: part.partitionIndex,
          committedOffset: committed?.toString() ?? null,
          endOffset: end?.toString() ?? null,
          lag: committed !== null && end !== undefined ? Math.max(0, Number(end - committed)) : null,
          endOffsetError: end === undefined ? `end offset of ${topic.name} could not be read` : null,
        });
      }
    }
    return rows.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
  }

  /** End offsets per topic, read once even when several groups consume it. */
  private async endOffsets(
    admin: KafkaWire["admin"],
    groups: readonly LibGroupOffsets[],
  ): Promise<Map<string, Map<number, bigint>>> {
    const names = [...new Set(groups.flatMap((group) => group.topics.map((topic) => topic.name)))];
    const result = new Map<string, Map<number, bigint>>();
    for (const name of names) {
      const partitions = await this.partitionsOf(admin, [name]);
      const marks = await this.watermarks(admin, name, partitions.get(name) ?? []);
      result.set(name, new Map([...marks].map(([partition, mark]) => [partition, mark.high])));
    }
    return result;
  }

  public async listConsumerGroups(): Promise<KafkaConsumerGroupListing> {
    return this.withAdmin("list consumer groups", async (admin) => {
      const listed = await admin.listGroups({ types: ["classic"] });
      const ids = [...listed.keys()].sort((a, b) => a.localeCompare(b));
      const described = await admin.describeGroups({ groups: ids });
      return {
        groups: ids.map((id) => {
          const group = described.get(id);
          return {
            groupId: id,
            state: group?.state ?? "Unknown",
            protocolType: group?.protocolType ?? "",
            protocol: group?.protocol ?? "",
            members: group?.members.size ?? 0,
            coordinator: null,
            internal: id.startsWith(PEEK_GROUP_PREFIX),
          };
        }),
      };
    });
  }

  public async measureGroupLag(groupIds: readonly string[]): Promise<Record<string, KafkaGroupLag>> {
    const ids = boundedBatch(groupIds, "consumer groups");
    if (ids.length === 0) return {};
    return this.withAdmin("measure consumer group lag", async (admin) => {
      const committed = await admin.listConsumerGroupOffsets({ groups: ids });
      const ends = await this.endOffsets(admin, committed);
      const result: Record<string, KafkaGroupLag> = {};
      for (const id of ids) {
        const entry = committed.find((group) => group.groupId === id);
        if (entry === undefined) {
          result[id] = { totalLag: null, lagError: "group has no committed offsets", topics: null };
          continue;
        }
        const rows = await this.groupOffsets(admin, id, ends);
        const unreadable = rows.find((row) => row.endOffsetError !== null);
        const topics = new Set(rows.filter((row) => row.committedOffset !== null).map((row) => row.topic)).size;
        result[id] =
          unreadable === undefined
            ? { totalLag: rows.reduce((sum, row) => sum + (row.lag ?? 0), 0), lagError: null, topics }
            : { totalLag: null, lagError: `${unreadable.topic}: ${unreadable.endOffsetError}`, topics };
      }
      return result;
    });
  }

  public async describeConsumerGroup(groupId: string): Promise<KafkaConsumerGroupDetail> {
    return this.withAdmin(`describe group "${groupId}"`, async (admin) => {
      const group = (await admin.describeGroups({ groups: [groupId] })).get(groupId);
      const committed = (await admin.listConsumerGroupOffsets({ groups: [groupId] })).find(
        (g) => g.groupId === groupId,
      );
      if (group === undefined || (committed === undefined && group.state === "Dead")) {
        throw new ResourceNotFoundError(`Consumer group "${groupId}" does not exist`);
      }
      const ends = await this.endOffsets(admin, committed === undefined ? [] : [committed]);
      return {
        groupId,
        state: group.state,
        protocolType: group.protocolType,
        protocol: group.protocol,
        members: [...group.members.entries()].map(([id, member]) => ({
          memberId: id,
          clientId: member.clientId,
          clientHost: member.clientHost,
          assignments: [],
        })),
        offsets: await this.groupOffsets(admin, groupId, ends),
      };
    });
  }

  /** A group may only have its offsets changed when every consumer has stopped. */
  private async requireEmptyGroup(admin: KafkaWire["admin"], groupId: string, action: string): Promise<void> {
    const group = (await admin.describeGroups({ groups: [groupId] })).get(groupId);
    const committed = (await admin.listConsumerGroupOffsets({ groups: [groupId] })).find((g) => g.groupId === groupId);
    if (group === undefined || (committed === undefined && group.state === "Dead")) {
      throw new ResourceNotFoundError(`Consumer group "${groupId}" does not exist`);
    }
    if (group.state !== "Empty" && group.state !== "Dead") {
      throw new ResourceConflictError(
        `Cannot ${action} consumer group "${groupId}" while it is ${group.state}: stop every consumer in the group first`,
      );
    }
  }

  public async resetConsumerGroupOffsets(input: KafkaResetOffsetsInput): Promise<readonly KafkaGroupOffset[]> {
    const { groupId, topic, reset, partitions } = input;
    return this.withAdmin(`reset offsets of "${groupId}" on "${topic}"`, async (admin) => {
      await this.requireTopic(admin, topic);
      await this.requireEmptyGroup(admin, groupId, "reset offsets of");
      const all = await this.partitionsOf(admin, [topic]);
      const chosen = (all.get(topic) ?? []).filter((part) => partitions === undefined || partitions.includes(part));
      if (chosen.length === 0) throw new ResourceNotFoundError(`Topic "${topic}" has none of those partitions`);
      const marks = await this.watermarks(admin, topic, chosen);
      const targets = await this.seekStarts(admin, topic, reset as KafkaSeek, chosen, marks);
      await admin.alterConsumerGroupOffsets({
        groupId,
        topics: [
          {
            name: topic,
            partitionOffsets: chosen.map((partition) => ({ partition, offset: targets.get(partition) ?? BigInt(0) })),
          },
        ],
      });
      return chosen.map((partition) => {
        const offset = targets.get(partition) ?? BigInt(0);
        const high = marks.get(partition)?.high ?? BigInt(0);
        return {
          topic,
          partition,
          committedOffset: offset.toString(),
          endOffset: high.toString(),
          lag: Math.max(0, Number(high - offset)),
          endOffsetError: null,
        };
      });
    });
  }

  public async deleteConsumerGroup(groupId: string): Promise<void> {
    await this.withAdmin(`delete group "${groupId}"`, async (admin) => {
      await this.requireEmptyGroup(admin, groupId, "delete");
      await admin.deleteGroups({ groups: [groupId] });
    });
  }
}

/** Exported for the route layer: the one place that knows a reset target's grammar. */
export function isKafkaOffsetReset(value: unknown): value is KafkaOffsetReset {
  if (typeof value !== "object" || value === null) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === "earliest" || mode === "latest" || mode === "offset" || mode === "timestamp";
}

/** Local re-export so a test can name the batch limit beside the provider. */
export { KAFKA_MEASURE_BATCH_LIMIT };
