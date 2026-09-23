import type { ResourceHealth, ResourceNode, ResourceNodePage } from "./types";

/**
 * The family operation interfaces, declared with the spine (M1) and implemented
 * by the provider modules as they land (M2-M4). They are separate interfaces
 * on purpose: a route downcasts only after checking the provider's declared
 * `operations`, so an unsupported operation is a 400 the ROUTE decides — never
 * a method the caller had to probe for.
 *
 * Reads are bounded with an explicit truncation flag; writes are the
 * full-management surface the fork committed to (confirm dialogs and audit
 * events live at the routes, not here).
 */

export interface BlobObjectMeta {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly lastModified: string | null;
  readonly contentType: string | null;
}

export interface BlobDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
}

export interface BlobPreview {
  /** What the preview decided the body is, so the viewer picks a pane, not a guess. */
  readonly kind: "text" | "image" | "binary";
  readonly text?: string;
  readonly truncated: boolean;
  readonly contentType: string | null;
}

export interface BlobOperations {
  listBuckets(): Promise<ResourceNodePage>;
  listObjects(bucket: string, prefix: string | null): Promise<ResourceNodePage>;
  readBlobMeta(bucket: string, name: string): Promise<BlobObjectMeta>;
  downloadBlob(bucket: string, name: string): Promise<BlobDownload>;
  previewBlob(bucket: string, name: string, byteLimit: number): Promise<BlobPreview>;
  uploadBlob(bucket: string, name: string, body: ReadableStream<Uint8Array>): Promise<BlobObjectMeta>;
  deleteBlob(bucket: string, name: string): Promise<void>;
}

export interface BrowseMessagesPage {
  readonly messages: readonly ResourceNode[];
  readonly truncated: boolean;
}

export interface MessagingOperations {
  listDestinations(): Promise<ResourceNodePage>;
  browseMessages(destination: string, limit: number): Promise<BrowseMessagesPage>;
  publishMessage(destination: string, body: string, attributes?: Record<string, string>): Promise<void>;
  purgeQueue(destination: string): Promise<void>;
}

export interface SecretVersion {
  readonly version: string | null;
  readonly createdAt: string | null;
}

export interface SecretRead {
  readonly name: string;
  readonly value: string;
  readonly metadata: SecretVersion | null;
}

export interface VaultOperations {
  listMounts(): Promise<ResourceNodePage>;
  listSecrets(mount: string, prefix: string | null): Promise<ResourceNodePage>;
  readSecret(path: string): Promise<SecretRead>;
  writeSecret(path: string, value: string): Promise<void>;
  deleteSecret(path: string): Promise<void>;
}

/** Narrowing helpers the routes use after the capability check. */
export function asBlobOperations(provider: object): BlobOperations | null {
  return "listBuckets" in provider ? (provider as BlobOperations) : null;
}

export function asMessagingOperations(provider: object): MessagingOperations | null {
  return "listDestinations" in provider ? (provider as MessagingOperations) : null;
}

export function asVaultOperations(provider: object): VaultOperations | null {
  return "listMounts" in provider ? (provider as VaultOperations) : null;
}

/*
 * The Kafka workbench surface (docs/resources/kafka.md). Its own interface, not
 * a widening of `MessagingOperations`: cluster, topic-admin and consumer-group
 * operations have no RabbitMQ/SQS meaning, and the generic messaging routes
 * keep serving the Resources section unchanged. Offsets travel as strings —
 * they are int64 on the wire and a JS number stops being exact at 2^53.
 */

export interface KafkaBroker {
  readonly nodeId: number;
  readonly host: string;
  readonly port: number;
  /** Always null on kafkajs 2.2.4: its describeCluster drops the rack field. */
  readonly rack: string | null;
  readonly isController: boolean;
}

export interface KafkaClusterOverview {
  readonly clusterId: string;
  readonly controllerId: number | null;
  readonly brokers: readonly KafkaBroker[];
}

export interface KafkaTopicSummary {
  readonly name: string;
  readonly internal: boolean;
  readonly partitions: number;
  readonly replicationFactor: number;
  readonly underReplicatedPartitions: number;
  /** Sum of high minus low watermarks — approximate (compaction, transaction markers); null past the count bound. */
  readonly messageCount: number | null;
}

export interface KafkaTopicListing {
  readonly topics: readonly KafkaTopicSummary[];
  /** True when message counts were skipped for some topics (the count bound). */
  readonly countsTruncated: boolean;
}

export interface KafkaPartitionDetail {
  readonly partition: number;
  readonly leader: number;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
  readonly offlineReplicas: readonly number[];
  readonly earliestOffset: string;
  readonly latestOffset: string;
}

export interface KafkaConfigEntry {
  readonly name: string;
  /** Null for sensitive entries: the broker never returns their value. */
  readonly value: string | null;
  readonly source: string;
  readonly isDefault: boolean;
  readonly readOnly: boolean;
  readonly isSensitive: boolean;
}

export interface KafkaTopicDetail {
  readonly name: string;
  readonly internal: boolean;
  readonly partitions: readonly KafkaPartitionDetail[];
  readonly configs: readonly KafkaConfigEntry[];
}

export interface KafkaCreateTopicInput {
  readonly name: string;
  readonly partitions: number;
  readonly replicationFactor: number;
  readonly configs?: Readonly<Record<string, string>>;
}

export type KafkaSeek =
  | { readonly mode: "earliest" }
  | { readonly mode: "latest" }
  | { readonly mode: "offset"; readonly offset: string }
  | { readonly mode: "timestamp"; readonly timestamp: number };

export interface KafkaReadQuery {
  /** One partition, or every partition when absent. */
  readonly partition?: number;
  readonly seek: KafkaSeek;
  readonly limit: number;
}

export interface KafkaRecord {
  readonly partition: number;
  readonly offset: string;
  readonly timestamp: string;
  readonly key: string | null;
  readonly value: string | null;
  /** "utf8" when the bytes decode cleanly; "base64" otherwise, so binary is shown, not mangled. */
  readonly keyEncoding: "utf8" | "base64";
  readonly valueEncoding: "utf8" | "base64";
  /** True when the value was cut at the per-record byte cap. */
  readonly valueTruncated: boolean;
  readonly valueBytes: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface KafkaMessagesPage {
  readonly messages: readonly KafkaRecord[];
  /** More messages exist in the requested window than this page carries. */
  readonly truncated: boolean;
}

export interface KafkaProduceInput {
  readonly key?: string;
  readonly value: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly partition?: number;
}

export interface KafkaProduceResult {
  readonly partition: number;
  readonly offset: string;
}

export interface KafkaConsumerGroupSummary {
  readonly groupId: string;
  readonly state: string;
  readonly protocolType: string;
  readonly protocol: string;
  readonly members: number;
  /** Null when lag was not measured (the lag bound, or the studio's own peek groups). */
  readonly totalLag: number | null;
  /** The studio's own throwaway peek groups — hidden by default in the UI. */
  readonly internal: boolean;
}

export interface KafkaConsumerGroupListing {
  readonly groups: readonly KafkaConsumerGroupSummary[];
  readonly lagTruncated: boolean;
}

export interface KafkaGroupMember {
  readonly memberId: string;
  readonly clientId: string;
  readonly clientHost: string;
  readonly assignments: ReadonlyArray<{ readonly topic: string; readonly partitions: readonly number[] }>;
}

export interface KafkaGroupOffset {
  readonly topic: string;
  readonly partition: number;
  /** Null when the group has no committed offset for the partition. */
  readonly committedOffset: string | null;
  readonly endOffset: string;
  readonly lag: number | null;
}

export interface KafkaConsumerGroupDetail {
  readonly groupId: string;
  readonly state: string;
  readonly protocolType: string;
  readonly protocol: string;
  readonly members: readonly KafkaGroupMember[];
  readonly offsets: readonly KafkaGroupOffset[];
}

export type KafkaOffsetReset =
  | { readonly mode: "earliest" }
  | { readonly mode: "latest" }
  | { readonly mode: "timestamp"; readonly timestamp: number }
  | { readonly mode: "offset"; readonly offset: string };

export interface KafkaResetOffsetsInput {
  readonly groupId: string;
  readonly topic: string;
  readonly reset: KafkaOffsetReset;
  /** Every partition of the topic when absent. */
  readonly partitions?: readonly number[];
}

export interface KafkaAdminOperations {
  describeCluster(): Promise<KafkaClusterOverview>;
  listTopicSummaries(): Promise<KafkaTopicListing>;
  describeTopic(topic: string): Promise<KafkaTopicDetail>;
  createTopic(input: KafkaCreateTopicInput): Promise<void>;
  deleteTopic(topic: string): Promise<void>;
  /** `count` is the new TOTAL, the Kafka protocol's own meaning. */
  addPartitions(topic: string, count: number): Promise<void>;
  /** `null` removes a topic-level override (back to the broker default). */
  alterTopicConfigs(topic: string, changes: Readonly<Record<string, string | null>>): Promise<void>;
  readMessages(topic: string, query: KafkaReadQuery): Promise<KafkaMessagesPage>;
  produceMessage(topic: string, input: KafkaProduceInput): Promise<KafkaProduceResult>;
  listConsumerGroups(): Promise<KafkaConsumerGroupListing>;
  describeConsumerGroup(groupId: string): Promise<KafkaConsumerGroupDetail>;
  resetConsumerGroupOffsets(input: KafkaResetOffsetsInput): Promise<readonly KafkaGroupOffset[]>;
  deleteConsumerGroup(groupId: string): Promise<void>;
}

export function asKafkaAdminOperations(provider: object): KafkaAdminOperations | null {
  return "describeCluster" in provider ? (provider as KafkaAdminOperations) : null;
}
