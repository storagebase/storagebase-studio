import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import {
  asKafkaAdminOperations,
  type KafkaAdminOperations,
  type KafkaOffsetReset,
  type KafkaSeek,
} from "@/lib/resources/operations";
import { ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import { ResourceRouteError, type ResourceRequestContext } from "@/lib/api/resource-route";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";
import type { ResourceConnection, ResourceOperation } from "@/lib/resources/types";

/**
 * Shared resolution and body validation for the Kafka workbench routes under
 * /api/resources/kafka — the messaging helper's twin: capability gate first,
 * downcast second, so a non-Kafka connection is a 400 the route decides.
 *
 * Shape is decided here, state by the provider: "partitions must be a
 * positive integer" is a 400 from this module, "the topic already has more
 * partitions" a 409 from the provider that read the topic.
 */

/** Kafka's own topic-name grammar (legal characters, 249-char ceiling). */
const TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;

const OFFSET = /^\d+$/;

export async function resolveKafkaOperations(
  connection: ResourceConnection,
  operation: ResourceOperation,
): Promise<KafkaAdminOperations> {
  const provider = await getOrCreateResourceProvider(connection);
  const operations = asKafkaAdminOperations(provider);
  if (!provider.getCapabilities().operations.includes(operation) || operations === null) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection does not support "${operation}"`);
  }
  return operations;
}

/**
 * One audited workbench write: the decision event, the provider call, the
 * outcome event joined by the same correlation id — the publish/purge shape,
 * held in one place so seven routes cannot drift from it.
 */
export async function auditedKafkaWrite<T>(
  connection: ResourceConnection,
  context: ResourceRequestContext,
  action: string,
  target: string,
  operation: ResourceOperation,
  run: (kafka: KafkaAdminOperations) => Promise<T>,
  request?: { headers: Headers },
): Promise<T> {
  const user = context.session.username ?? context.session.role;
  const auditTarget = `${connection.type}:${target}`;
  // The request rides along so both events carry the caller's address and agent.
  const correlationId = beginResourceWrite(user, action, auditTarget, request, connection);
  try {
    const result = await run(await resolveKafkaOperations(connection, operation));
    endResourceWrite(user, action, auditTarget, correlationId, null, request, connection);
    return result;
  } catch (error) {
    endResourceWrite(user, action, auditTarget, correlationId, error, request, connection);
    throw error;
  }
}

export function requireTopicName(body: Record<string, unknown>): string {
  const topic = body.topic;
  if (typeof topic !== "string" || !TOPIC_NAME.test(topic) || topic === "." || topic === "..") {
    throw new ResourceRouteError(
      '"topic" must be a Kafka topic name (letters, digits, ".", "_", "-"; at most 249)',
      400,
    );
  }
  return topic;
}

export function requireGroupId(body: Record<string, unknown>): string {
  if (typeof body.groupId !== "string" || body.groupId.trim() === "") {
    throw new ResourceRouteError('"groupId" must be a non-empty string', 400);
  }
  return body.groupId;
}

export function requireInteger(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ResourceRouteError(`"${field}" must be an integer between ${min} and ${max}`, 400);
  }
  return value;
}

export function optionalPartition(body: Record<string, unknown>): number | undefined {
  if (body.partition === undefined || body.partition === null) return undefined;
  return requireInteger(body, "partition", 0, 1_000_000);
}

export function optionalStringMap(body: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResourceRouteError(`"${field}" must be a string-to-string map when present`, 400);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new ResourceRouteError(`"${field}.${name}" must be a string`, 400);
  }
  return value as Record<string, string>;
}

function requireOffset(value: unknown, field: string): string {
  if (typeof value !== "string" || !OFFSET.test(value)) {
    throw new ResourceRouteError(`"${field}" must be a non-negative integer offset written as a string`, 400);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ResourceRouteError(`"${field}" must be a non-negative epoch-millisecond integer`, 400);
  }
  return value;
}

/** `{ mode: "earliest" | "latest" | "offset" | "timestamp", offset?, timestamp? }` — the read's seek. */
export function requireSeek(body: Record<string, unknown>): KafkaSeek {
  const seek = body.seek as Record<string, unknown> | undefined;
  const mode = typeof seek === "object" && seek !== null ? seek.mode : undefined;
  if (mode === "earliest" || mode === "latest") return { mode };
  if (mode === "offset")
    return { mode, offset: requireOffset((seek as Record<string, unknown>).offset, "seek.offset") };
  if (mode === "timestamp") {
    return { mode, timestamp: requireTimestamp((seek as Record<string, unknown>).timestamp, "seek.timestamp") };
  }
  throw new ResourceRouteError('"seek.mode" must be one of earliest, latest, offset, timestamp', 400);
}

/** The reset target; the same grammar as the seek, named for what it does. */
export function requireReset(body: Record<string, unknown>): KafkaOffsetReset {
  return requireSeek({ seek: body.reset });
}

export function optionalPartitionList(body: Record<string, unknown>): number[] | undefined {
  const value = body.partitions;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
  ) {
    throw new ResourceRouteError('"partitions" must be a non-empty array of partition numbers when present', 400);
  }
  return value as number[];
}

/** Config edits: a map of name to new value, or null to drop the topic-level override. */
export function requireConfigChanges(body: Record<string, unknown>): Record<string, string | null> {
  const value = body.changes;
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new ResourceRouteError('"changes" must be a non-empty map of config name to value (or null)', 400);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== "string") {
      throw new ResourceRouteError(`"changes.${name}" must be a string or null`, 400);
    }
  }
  return value as Record<string, string | null>;
}
