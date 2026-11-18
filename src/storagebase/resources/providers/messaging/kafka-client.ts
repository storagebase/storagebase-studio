import type { SSLConfig } from "@/lib/types";
import { loadPlatformatic } from "@/lib/db/providers/stream/kafka/platformatic-client";
import { ResourceConfigError } from "../../errors";

/**
 * The fork's WRITE-CAPABLE Kafka client (StorageBase fork, REFORK_ANALYSIS 5.4 change 2).
 *
 * Upstream's `stream/kafka` provider is a reader: its adapter hands back only the
 * `KAFKA_READ_APIS` surface and its connection mapping yields ONE broker and refuses
 * SASL without TLS. This module is a SEPARATE instance on the same `@platformatic/kafka`
 * 2.14.0 dependency: it keeps the library's full Admin + Producer + Consumer surface,
 * accepts a multi-broker bootstrap list and OAUTHBEARER, and is loaded through this
 * file only (SEAMS.md S12 pins it as the fork's one extra library importer).
 *
 * `loadForkKafka` reuses upstream's `loadPlatformatic()` for its one global side
 * effect — muting the protocol logger, which prints the first bytes of a SASL PLAIN
 * frame (the password). It then imports the library itself for the full, writable
 * client constructors. Everything here is pure or lazy: no socket opens at import.
 */

/** Bootstrap address of one broker. */
export interface ForkKafkaBroker {
  readonly host: string;
  readonly port: number;
}

export interface ForkKafkaTls {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly rejectUnauthorized: boolean;
}

export type ForkKafkaSaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512" | "OAUTHBEARER";

export interface ForkKafkaSasl {
  readonly mechanism: ForkKafkaSaslMechanism;
  readonly username: string;
  readonly password: string;
}

export interface ForkKafkaOptions {
  readonly clientId: string;
  readonly brokers: readonly ForkKafkaBroker[];
  readonly tls?: ForkKafkaTls;
  readonly sasl?: ForkKafkaSasl;
  readonly timeoutMs: number;
}

/**
 * The addressing/credential shape both connection records carry. The workbench
 * resolves an UPSTREAM `kafka` DatabaseConnection (host/port/ssl/saslMechanism/user/
 * password/token); the generic fork resource layer carries `endpoint`/`token`. One
 * reader serves both so there is only one mapping to test and to reason about.
 */
export interface KafkaConnectionConfig {
  readonly host?: string | null;
  readonly port?: number | null;
  readonly endpoint?: string | null;
  readonly ssl?: SSLConfig | null;
  readonly saslMechanism?: string | null;
  readonly user?: string | null;
  readonly password?: string | null;
  readonly token?: string | null;
}

const SASL_MECHANISMS: readonly ForkKafkaSaslMechanism[] = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER"];
const FORBIDDEN_IN_CREDENTIAL = /[\r\n\0]/;
const DEFAULT_PORT = 9092;

/** Names the field and what it must be, never the value it holds, which can be a credential. */
function wrongType(field: string, expected: string): ResourceConfigError {
  return new ResourceConfigError(`The connection's ${field} must be ${expected}; nothing was sent`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw wrongType(field, "a string");
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw wrongType(field, "true or false");
  return value;
}

/** Parse `host:port[,host:port…]`; a bare host keeps the default port. IPv6 literals are bracketed. */
function parseBroker(text: string): ForkKafkaBroker {
  const trimmed = text.trim();
  if (trimmed === "") throw new ResourceConfigError("A Kafka broker address must not be empty");
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed !== null) {
    const port = bracketed[2] === undefined ? DEFAULT_PORT : Number(bracketed[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw wrongType("broker port", "a port from 1 to 65535");
    return { host: bracketed[1], port };
  }
  const parts = trimmed.split(":");
  if (parts.length > 2) throw new ResourceConfigError(`Invalid Kafka broker address "${trimmed}"`);
  const host = parts[0];
  if (host === "") throw new ResourceConfigError("A Kafka broker requires a host");
  const port = parts[1] === undefined ? DEFAULT_PORT : Number(parts[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw wrongType("broker port", "a port from 1 to 65535");
  return { host, port };
}

/** brokers from the comma-separated endpoint, or from host + port (the upstream seed shape). */
export function forkKafkaBrokers(config: KafkaConnectionConfig): readonly ForkKafkaBroker[] {
  const endpoint = optionalString(config.endpoint, "endpoint");
  if (endpoint !== undefined && endpoint.trim() !== "") {
    const listed = endpoint.split(",").map(parseBroker);
    return listed;
  }
  const host = optionalString(config.host, "host");
  if (host === undefined || host.trim() === "") {
    throw new ResourceConfigError('A Kafka connection requires a host or an "endpoint" bootstrap list');
  }
  const port = config.port;
  if (port !== undefined && port !== null && (typeof port !== "number" || !Number.isInteger(port))) {
    throw wrongType("port", "a number");
  }
  return [{ host: host.trim(), port: port ?? DEFAULT_PORT }];
}

/** TLS options, with the same Couchbase rule upstream mirrors: require is the only non-verifying mode. */
function tlsOptions(config: KafkaConnectionConfig): ForkKafkaTls | undefined {
  const panel = config.ssl;
  if (panel === undefined || panel === null) return undefined;
  if (typeof panel !== "object" || Array.isArray(panel)) throw wrongType("ssl", "an object");
  const mode = panel.mode;
  if (
    mode !== undefined &&
    mode !== "disable" &&
    mode !== "require" &&
    mode !== "verify-system" &&
    mode !== "verify-ca" &&
    mode !== "verify-full"
  ) {
    throw wrongType("ssl.mode", "disable, require, verify-system, verify-ca or verify-full");
  }
  const ca = optionalString(panel.caCert, "ssl.caCert");
  const cert = optionalString(panel.clientCert, "ssl.clientCert");
  const key = optionalString(panel.clientKey, "ssl.clientKey");
  const reject = optionalBoolean(panel.rejectUnauthorized, "ssl.rejectUnauthorized");
  if (mode === "disable") return undefined;
  return {
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    rejectUnauthorized: reject ?? mode !== "require",
  };
}

/** SASL options. The fork adds OAUTHBEARER (a token in the password slot) to upstream's PLAIN/SCRAM. */
function saslOptions(config: KafkaConnectionConfig, tlsOn: boolean): ForkKafkaSasl | undefined {
  const mechanism = config.saslMechanism;
  const user = optionalString(config.user, "user") ?? "";
  const password = optionalString(config.password, "password") ?? optionalString(config.token, "token") ?? "";
  if (mechanism === undefined || mechanism === null) {
    if (user !== "" || password !== "") {
      throw new ResourceConfigError("A Kafka user or password needs a SASL mechanism: choose one or clear both fields");
    }
    return undefined;
  }
  if (typeof mechanism !== "string" || !SASL_MECHANISMS.includes(mechanism as ForkKafkaSaslMechanism)) {
    throw new ResourceConfigError("The SASL mechanism must be PLAIN, SCRAM-SHA-256, SCRAM-SHA-512 or OAUTHBEARER");
  }
  if (!tlsOn) {
    throw new ResourceConfigError(
      `${mechanism} requires TLS: without it the credential or the session travels in the clear`,
    );
  }
  for (const [field, value] of [
    ["user", user],
    ["password", password],
  ] as const) {
    if (FORBIDDEN_IN_CREDENTIAL.test(value)) {
      throw new ResourceConfigError(
        `The ${field} contains a line break or NUL, which SASL cannot carry; nothing was sent`,
      );
    }
  }
  return { mechanism: mechanism as ForkKafkaSaslMechanism, username: user, password };
}

/** The full option set the writable client is built from. Pure: no socket opens here. */
export function forkKafkaConnectionOptions(config: KafkaConnectionConfig, timeoutMs = 30_000): ForkKafkaOptions {
  const tls = tlsOptions(config);
  const sasl = saslOptions(config, tls !== undefined);
  return {
    clientId: "storagebase-studio",
    brokers: forkKafkaBrokers(config),
    ...(tls === undefined ? {} : { tls }),
    ...(sasl === undefined ? {} : { sasl }),
    timeoutMs,
  };
}

/** One metadata answer, normalized to the fields the workbench reads. */
export interface LibMetadata {
  readonly clusterId: string;
  readonly controllerId: number;
  readonly brokers: ReadonlyMap<number, { host: string; port: number; rack: string | null }>;
  readonly topics: ReadonlyMap<
    string,
    {
      readonly id: string;
      readonly partitions: ReadonlyArray<{
        readonly leader: number;
        readonly replicas: readonly number[];
        readonly isr: readonly number[];
        readonly offlineReplicas: readonly number[];
      }>;
    }
  >;
}

export interface LibConfigEntry {
  readonly name: string;
  readonly value: string | null;
  readonly readOnly: boolean;
  readonly isSensitive: boolean;
  readonly configSource: number;
  readonly isDefault: boolean;
}

export interface LibConfigDescription {
  readonly resourceName: string;
  readonly configs: readonly LibConfigEntry[];
}

export interface LibOffsetsTopic {
  readonly name: string;
  readonly partitions: ReadonlyArray<{ readonly partitionIndex: number; readonly offset: bigint }>;
}

export interface LibGroup {
  readonly state: string;
  readonly protocolType: string;
  readonly protocol: string;
  readonly members: ReadonlyMap<string, { readonly clientId: string; readonly clientHost: string }>;
  readonly error?: unknown;
}

export interface LibGroupOffsets {
  readonly groupId: string;
  readonly topics: ReadonlyArray<{
    readonly name: string;
    readonly partitions: ReadonlyArray<{
      readonly partitionIndex: number;
      readonly committedOffset: bigint;
    }>;
  }>;
}

export interface LibMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
  readonly timestamp: bigint;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly headers: ReadonlyMap<Uint8Array, Uint8Array>;
}

/** The Admin surface this workbench calls — the library's real method names and shapes. */
export interface ForkAdmin {
  metadata(options: object): Promise<LibMetadata>;
  listTopics(options?: object): Promise<string[]>;
  listOffsets(options: object): Promise<readonly LibOffsetsTopic[]>;
  describeConfigs(options: object): Promise<readonly LibConfigDescription[]>;
  incrementalAlterConfigs(options: object): Promise<void>;
  createTopics(options: object): Promise<unknown>;
  createPartitions(options: object): Promise<void>;
  deleteTopics(options: object): Promise<void>;
  listGroups(
    options?: object,
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly state: string; readonly protocolType: string }>>;
  describeGroups(options: object): Promise<ReadonlyMap<string, LibGroup>>;
  deleteGroups(options: object): Promise<void>;
  listConsumerGroupOffsets(options: object): Promise<readonly LibGroupOffsets[]>;
  alterConsumerGroupOffsets(options: object): Promise<void>;
  close(): Promise<void>;
}

export interface ForkProducer {
  send(options: object): Promise<ReadonlyArray<{ readonly partition: number; readonly baseOffset?: bigint | null }>>;
  close(): Promise<void>;
}

export interface ForkMessageStream extends AsyncIterable<LibMessage> {
  close(): Promise<void>;
}

export interface ForkConsumer {
  consume(options: object): Promise<ForkMessageStream>;
  close(): Promise<void>;
}

/** The writable library's four constructors, shaped so a test can inject a fake in place of the SDK. */
export interface ForkKafkaLibrary {
  readonly Admin: new (options: object) => ForkAdmin;
  readonly Producer: new (options: object) => ForkProducer;
  readonly Consumer: new (options: object) => ForkConsumer;
}

/**
 * Load the library. Upstream's loader is taken first so its protocol-log mute is
 * applied once per process; the direct dynamic import then hands back the FULL
 * library (including `Producer`), which upstream's read-only adapter does not expose.
 */
export async function loadForkKafka(
  load: () => Promise<ForkKafkaLibrary> = () => import("@platformatic/kafka") as unknown as Promise<ForkKafkaLibrary>,
): Promise<ForkKafkaLibrary> {
  await loadPlatformatic();
  return load();
}

/** The three clients a workbench read or write needs, built with write-capable options. */
export interface KafkaWire {
  readonly admin: ForkAdmin;
  readonly producer: ForkProducer;
  readonly newConsumer: (groupId: string) => ForkConsumer;
  readonly close: () => Promise<void>;
}

function sharedOptions(options: ForkKafkaOptions): object {
  return {
    clientId: options.clientId,
    bootstrapBrokers: [...options.brokers],
    autocreateTopics: false,
    retries: 1,
    connectTimeout: options.timeoutMs,
    requestTimeout: options.timeoutMs,
    ...(options.tls === undefined ? {} : { tls: options.tls, tlsServerName: true }),
    ...(options.sasl === undefined ? {} : { sasl: options.sasl }),
  };
}

/** Construct the real clients. The only place that touches the library's constructors. */
export function createKafkaWire(options: ForkKafkaOptions, lib: ForkKafkaLibrary): KafkaWire {
  const base = sharedOptions(options);
  const admin = new lib.Admin(base);
  const producer = new lib.Producer(base);
  return {
    admin,
    producer,
    newConsumer: (groupId) =>
      new lib.Consumer({ ...base, groupId, autocommit: false, groupProtocol: "classic", maxFetches: 1 }),
    close: async () => {
      await Promise.all([admin.close(), producer.close()]);
    },
  };
}
