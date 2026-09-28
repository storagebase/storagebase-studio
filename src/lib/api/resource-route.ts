import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { isResourceType, type ResourceConnection } from "@/lib/resources/types";
import { MANAGED_RESOURCE_PREFIX, resolveManagedResource } from "@/lib/access/resolve";
import { requireResourcePermission } from "@/lib/access/resource-guard";
import { parseUserConnectionId } from "@/lib/user-connections/ids";
import { resolveUserConnection } from "@/lib/user-connections/server";
// Family provider registration (server side): every resource route runs
// through this handler, so one import covers the whole namespace.
import "@/lib/resources/providers";

/** The inline `connection` field every resource route's body carries. */
export function isResourceConnection(value: unknown): value is ResourceConnection {
  if (typeof value !== "object" || value === null) return false;
  return isResourceType((value as Record<string, unknown>).type);
}

/**
 * Shared request handling for the resource routes under /api/resources (the
 * StorageBase fork's parallel layer). One handler rather than one per route for
 * the same reason `handleObjectRequest` gives: the guard-before-parse ordering
 * below is a security property, and copies of it are chances for one to drift.
 *
 * The body carries a user-owned resource connection INLINE as `connection` —
 * the same contract user-owned database connections use, because resource
 * connections live in the same write-through localStorage store. A MANAGED
 * connection (src/lib/access) arrives as `{ connectionId: "managed:<id>" }`
 * instead and resolves here, beside the parse, and nowhere else: the server
 * loads and decrypts it, answers 404 when the caller's roles grant nothing on
 * it (exactly as for an id that does not exist), and 403 when the grant is
 * lower than this route needs. Its credentials never reach the browser. A
 * user's OWN connection saved with server storage arrives as
 * `{ connectionId: "user:<id>" }` and resolves from that user's store
 * (src/lib/user-connections) — another user's id is a 404 like any unknown one.
 */
export async function handleResourceRequest(
  req: NextRequest,
  route: string,
  run: (
    connection: ResourceConnection,
    body: Record<string, unknown>,
    context: ResourceRequestContext,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  // Ahead of body parsing: an unauthenticated caller never gets a body parsed on
  // its behalf, and the rate limiter sees the request before work is done for it.
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await readResourceBody(req);
    const connection = await resolveResourceConnection(req, body, guard.session, route);
    return await run(connection, body, { session: guard.session, route, connection });
  } catch (error) {
    if (error instanceof ResourceRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return createErrorResponse(error, { route });
  }
}

/**
 * The connection a request runs against: a managed one by id, or the caller's own inline one. An
 * inline connection may not claim a managed id — the provider cache is keyed by id, so one that
 * could would be asking to be handed the managed connection's open client.
 */
async function resolveResourceConnection(
  req: NextRequest,
  body: Record<string, unknown>,
  session: ResourceRequestContext["session"],
  route: string,
): Promise<ResourceConnection> {
  if (parseUserConnectionId(body.connectionId) !== null) {
    const owned = await resolveUserConnection(session.username, "resource", body.connectionId);
    if (!owned || !isResourceConnection(owned)) throw new ResourceRouteError("Resource connection not found", 404);
    return owned;
  }
  if (typeof body.connectionId === "string") {
    const managed = await resolveManagedResource(body.connectionId, session);
    if (!managed) throw new ResourceRouteError("Resource connection not found", 404);
    requireResourcePermission(req, session, managed, route);
    return managed;
  }
  if (!isResourceConnection(body.connection)) {
    throw new ResourceRouteError("A resource connection with a valid resource type is required", 400);
  }
  if (typeof body.connection.id === "string" && body.connection.id.startsWith(MANAGED_RESOURCE_PREFIX)) {
    throw new ResourceRouteError(`Connection ids starting with "${MANAGED_RESOURCE_PREFIX}" are reserved`, 400);
  }
  return body.connection;
}

/**
 * What a resource route gets beside the connection and the body. The session is
 * the guard's, so an audit event names the caller this request was authorised
 * as — the same rule `ObjectRequestContext` follows for the database routes.
 */
export interface ResourceRequestContext {
  readonly session: { readonly role: string; readonly username?: string };
  readonly route: string;
  /** The connection the action runs against, for the audit event's connection fields. */
  readonly connection: Pick<ResourceConnection, "id" | "name" | "type">;
}

async function readResourceBody(req: NextRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    throw new ResourceRouteError("Empty request body", 400);
  }
  if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
    throw new ResourceRouteError("Empty request body", 400);
  }
  return body;
}

/**
 * A refusal this layer decides for itself: a caller mistake the provider must
 * never be asked to interpret (400), or a managed connection that is not there
 * for this caller (404). Kept parallel to
 * `ObjectRouteError` rather than importing it, so the fork's status vocabulary
 * lives in the fork's files.
 */
export class ResourceRouteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ResourceRouteError";
  }
}
