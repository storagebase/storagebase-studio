import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminRequiredResponse, guardRoute } from "@/lib/api/require-session";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import type { DatabaseConnection } from "@/lib/types";
import { resolveStoredResourceWithGrant } from "../../connections";
import { openSeededResourceConnection } from "../../seed";
import {
  beginResourceWrite,
  endResourceWrite,
  type ResourceAuditConnection,
  type ResourceRequestContext,
} from "@/storagebase/audit/resource";
import { forkResourceErrorResponse } from "../../handle-request";
import { ResourceAccessDeniedError, ResourceInvalidRequestError, ResourceRouteError } from "../../errors";
import { permits } from "../../permissions";
import { isResourceType, RESOURCE_CATEGORY_OF, type ResourceConnection, type ResourcePermission } from "../../types";
import { KafkaProvider } from "./kafka";
import type { KafkaOffsetReset, KafkaSeek } from "../../operations";

/**
 * The Kafka workbench's one guard→resolve→permission door, ported from the
 * legacy `resource-route` + `resource-kafka` pair onto the re-fork's design:
 *
 * - the connection is an UPSTREAM `kafka` seed record resolved through
 *   upstream's `resolveConnection` (decrypted, Vault-resolved, role-filtered
 *   server-side) — there is no second fork-store record;
 * - `readOnly` on that record and the three fork permission levels decide the
 *   route; admin routes additionally use upstream's `adminRequiredResponse`;
 * - every route calls `guardRoute` first, so the route-auth census's exact 401
 *   is produced before a body is parsed or a connection resolved.
 */

/** Level each of the 15 workbench routes needs. A route missing here needs `admin` (fail closed). */
export const KAFKA_ROUTE_PERMISSIONS: Readonly<Record<string, ResourcePermission>> = {
  "api/sb/kafka/cluster": "read",
  "api/sb/kafka/topics": "read",
  "api/sb/kafka/topics/counts": "read",
  "api/sb/kafka/topic": "read",
  "api/sb/kafka/messages": "read",
  "api/sb/kafka/groups": "read",
  "api/sb/kafka/groups/lag": "read",
  "api/sb/kafka/group": "read",

  "api/sb/kafka/topic/create": "write",
  "api/sb/kafka/topic/partitions": "write",
  "api/sb/kafka/topic/config": "write",
  "api/sb/kafka/produce": "write",

  "api/sb/kafka/topic/delete": "admin",
  "api/sb/kafka/group/reset-offsets": "admin",
  "api/sb/kafka/group/delete": "admin",
};

export function kafkaRoutePermission(route: string): ResourcePermission {
  return Object.hasOwn(KAFKA_ROUTE_PERMISSIONS, route) ? KAFKA_ROUTE_PERMISSIONS[route] : "admin";
}

/** `readOnly` wins over the grant and the role; the definer's grant wins over the role; else role. */
export function kafkaGrantedPermission(
  connection: DatabaseConnection | ResourceConnection,
  role: string,
): ResourcePermission {
  if ("readOnly" in connection && connection.readOnly === true) return "read";
  if ("permission" in connection && connection.permission !== undefined) return connection.permission;
  return role === "admin" ? "admin" : "write";
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (body === null || typeof body !== "object" || Object.keys(body).length === 0) {
      throw new ResourceRouteError("Empty request body");
    }
    return body;
  } catch (error) {
    if (error instanceof ResourceRouteError) throw error;
    throw new ResourceRouteError("Empty request body");
  }
}

/** The resolved connection's id/name/type for the audit trail — never its credentials. */
function auditFields(connection: DatabaseConnection | ResourceConnection): ResourceAuditConnection {
  return { id: connection.id, name: connection.name, type: connection.type };
}

export interface KafkaRequestContext extends ResourceRequestContext {
  readonly connection: ResourceAuditConnection;
  /** Either connection record: upstream kafka seeds and fork resource connections are both served. */
  readonly resolved: DatabaseConnection | ResourceConnection;
}

/**
 * The connection behind a workbench request. The ANALYSIS's one-record rule is kept for upstream
 * kafka seeds (resolveConnection, role-checked and Vault-resolved server-side); a FORK resource
 * connection — one the section rail's catalog creates — resolves through the fork layer instead,
 * never as a second copy of an upstream record. Both shapes are read by KafkaConnectionConfig.
 */
async function resolveKafkaConnection(
  body: Record<string, unknown>,
  session: { role: string; username: string; claimRoles?: readonly string[] | unknown },
): Promise<DatabaseConnection | ResourceConnection> {
  const connectionId = body.connectionId as string | undefined;
  if (connectionId === undefined) {
    return await resolveConnection({ connection: body.connection as DatabaseConnection | undefined }, session as never);
  }
  try {
    return await resolveConnection({ connectionId }, session as never);
  } catch (upstreamError) {
    const seeded = await openSeededResourceConnection(session, connectionId);
    if (seeded !== null) return { ...seeded.connection, permission: seeded.permission };
    if (connectionId.startsWith("res_")) return (await resolveStoredResourceWithGrant(connectionId)).connection;
    throw upstreamError;
  }
}

/**
 * Guard, parse, resolve, decide, then hand a ready provider to the route. The
 * route owns only its body validation and its provider call; the security
 * ordering lives here in one place.
 */
export async function handleKafkaRequest(
  req: NextRequest,
  route: string,
  run: (provider: KafkaProvider, body: Record<string, unknown>, ctx: KafkaRequestContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readBody(req);
    const connection = await resolveKafkaConnection(body, guard.session);
    // The workbench serves the fork's messaging resource type. Checking through
    // the fork's registered category table keeps the engine-branch census clean
    // (the shared spelling "kafka" is an upstream engine id too).
    if (!isResourceType(connection.type) || RESOURCE_CATEGORY_OF[connection.type] !== "messaging") {
      throw new ResourceInvalidRequestError("This connection is not a Kafka workbench connection");
    }
    const required = kafkaRoutePermission(route);
    const granted = kafkaGrantedPermission(connection, guard.session.role);
    if (!permits(granted, required)) {
      if (required === "admin") return adminRequiredResponse();
      throw new ResourceAccessDeniedError(granted, required, connection.name);
    }
    const ctx: KafkaRequestContext = {
      session: guard.session,
      route,
      connection: auditFields(connection),
      resolved: connection,
    };
    return await run(new KafkaProvider(connection), body, ctx);
  } catch (error) {
    return forkResourceErrorResponse(error, { route });
  }
}

/** One audited workbench read: a single outcome event, counts only, never a value. */
export async function auditedKafkaRead<T>(
  ctx: KafkaRequestContext,
  req: NextRequest,
  action: string,
  target: string,
  provider: KafkaProvider,
  run: (provider: KafkaProvider) => Promise<T>,
  counts?: (result: T) => Record<string, number | boolean>,
): Promise<T> {
  const { auditedResourceRead } = await import("@/storagebase/audit/resource");
  return auditedResourceRead(ctx, req, action, target, () => run(provider), counts);
}

/** One audited workbench write: decision and outcome joined by one correlation id. */
export async function auditedKafkaWrite<T>(
  ctx: KafkaRequestContext,
  req: NextRequest,
  action: string,
  target: string,
  provider: KafkaProvider,
  run: (provider: KafkaProvider) => Promise<T>,
): Promise<T> {
  const user = ctx.session.username ?? ctx.session.role;
  const correlationId = beginResourceWrite(user, action, target, req, ctx.connection);
  try {
    const result = await run(provider);
    endResourceWrite(user, action, target, correlationId, null, req, ctx.connection);
    return result;
  } catch (error) {
    endResourceWrite(user, action, target, correlationId, error, req, ctx.connection);
    throw error;
  }
}

// --- Body validation, shared by the route files ---------------------------

const TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;
const OFFSET = /^\d+$/;

export function isTopicName(name: string): boolean {
  return TOPIC_NAME.test(name) && name !== "." && name !== "..";
}

export function isGroupId(name: string): boolean {
  return name.trim() !== "";
}

export function requireTopicName(body: Record<string, unknown>): string {
  const topic = body.topic;
  if (typeof topic !== "string" || !isTopicName(topic)) {
    throw new ResourceRouteError('"topic" must be a Kafka topic name (letters, digits, ".", "_", "-"; at most 249)');
  }
  return topic;
}

export function requireGroupId(body: Record<string, unknown>): string {
  if (typeof body.groupId !== "string" || !isGroupId(body.groupId)) {
    throw new ResourceRouteError('"groupId" must be a non-empty string');
  }
  return body.groupId;
}

export function requireNameBatch(
  body: Record<string, unknown>,
  field: string,
  valid: (name: string) => boolean,
): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new ResourceRouteError(`"${field}" must be an array of 1 to 50 names`, 400);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !valid(entry)) {
      throw new ResourceRouteError(`"${field}" holds an invalid name: ${JSON.stringify(entry)}`);
    }
  }
  return value as string[];
}

export function requireInteger(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ResourceRouteError(`"${field}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function optionalPartition(body: Record<string, unknown>): number | undefined {
  if (body.partition === undefined || body.partition === null) return undefined;
  return requireInteger(body, "partition", 0, 1_000_000);
}

export function optionalPartitionList(body: Record<string, unknown>): number[] | undefined {
  const value = body.partitions;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
  ) {
    throw new ResourceRouteError('"partitions" must be a non-empty array of partition numbers when present');
  }
  return value as number[];
}

export function optionalStringMap(body: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResourceRouteError(`"${field}" must be a string-to-string map when present`);
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new ResourceRouteError(`"${field}.${name}" must be a string`);
  }
  return value as Record<string, string>;
}

function requireOffset(value: unknown, field: string): string {
  if (typeof value !== "string" || !OFFSET.test(value)) {
    throw new ResourceRouteError(`"${field}" must be a non-negative integer offset written as a string`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ResourceRouteError(`"${field}" must be a non-negative epoch-millisecond integer`);
  }
  return value;
}

/** `{ mode: "earliest" | "latest" | "offset" | "timestamp", offset?, timestamp? }`. */
export function requireSeek(body: Record<string, unknown>): KafkaSeek {
  const seek = body.seek as Record<string, unknown> | undefined;
  const mode = typeof seek === "object" && seek !== null ? seek.mode : undefined;
  if (mode === "earliest" || mode === "latest") return { mode };
  if (mode === "offset") return { mode, offset: requireOffset(seek?.offset, "seek.offset") };
  if (mode === "timestamp") return { mode, timestamp: requireTimestamp(seek?.timestamp, "seek.timestamp") };
  throw new ResourceRouteError('"seek.mode" must be one of earliest, latest, offset, timestamp');
}

/** The reset target: the seek grammar under a different field name. */
export function requireReset(body: Record<string, unknown>): KafkaOffsetReset {
  return requireSeek({ seek: body.reset });
}

export function requireConfigChanges(body: Record<string, unknown>): Record<string, string | null> {
  const value = body.changes;
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new ResourceRouteError('"changes" must be a non-empty map of config name to value (or null)');
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== "string") {
      throw new ResourceRouteError(`"changes.${name}" must be a string or null`);
    }
  }
  return value as Record<string, string | null>;
}

/** A typed confirmation by name for the three irreversible admin routes. */
export function requireConfirmName(body: Record<string, unknown>, topic: string): void {
  if (body.confirm !== topic) throw new ResourceRouteError('"confirm" must repeat the topic name exactly');
}
