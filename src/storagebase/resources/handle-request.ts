import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import type { UserPayload } from "@/lib/auth";
import { endResourceWrite, type ResourceAuditConnection } from "@/storagebase/audit/resource";
import { resolveStoredResourceConnection } from "./connections";
import { ResourceAccessDeniedError, ResourceError, ResourceNotFoundError, ResourceRouteError } from "./errors";
import { permits, resourceRoutePermission } from "./permissions";
import { openSeededResourceConnection } from "./seed";
import { isResourceType, type ResourceConnection, type SeededResourceConnection } from "./types";
// Family provider registration (server side): every resource route runs
// through this handler, so one import covers the whole namespace. Phase 2a's
// barrel is empty; a family's first line is its whole integration.
import "./providers";

/**
 * Shared request handling for the fork resource routes under
 * /api/sb/resources (StorageBase fork, ported from the legacy
 * src/lib/api/resource-route.ts). One handler rather than one per route for
 * the same reason upstream's `handleObjectRequest` gives: the
 * guard-before-parse ordering below is a security property, and copies of it
 * are chances for one to drift.
 *
 * A connection is named by id, and the server resolves it — credentials never
 * travel back and forth on every request:
 * - `{ connectionId: "seed:<id>" }` a preconfigured connection from the fork
 *   seed file, resolved only for a session whose roles select it (a miss
 *   answers the same 404 an unknown id does, so a non-member learns nothing),
 *   then gated by the route's permission level before anything is opened, and
 *   its `${vault:…}` references read only after that decision.
 * - `{ connectionId: "<stored id>" }` a user-created connection from the
 *   fork store, sealed fields opened server-side. With no store configured
 *   the honest answer is 503 SB_STORE_UNAVAILABLE, never an empty pretending.
 * - `{ connection }` the pre-save candidate the connection form is still
 *   editing (tested before it is ever stored) or a connection an embedding
 *   host passes in: inline, credentials and all, and it may not claim the
 *   `seed:` namespace. A stored connection used to be nameable this way too;
 *   the fork store makes the id path the only one for saved connections, so
 *   the provider cache is keyed by ids the server minted.
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
  // The `query` bucket is reused by design (P3: the fork adds no rate-limit bucket).
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await readResourceBody(req);
    const connection = await resolveResourceConnection(body, guard.session, route, req);
    return await run(connection, body, {
      session: guard.session,
      route,
      connection: connectionAuditFields(connection),
    });
  } catch (error) {
    return forkResourceErrorResponse(error, { route });
  }
}

// The route-layer refusal class, re-exported for the route files (and the
// phase 3-4 family routes) exactly as the legacy resource-route.ts exported it.
export { ResourceRouteError } from "./errors";

/** What a fork resource route gets beside the connection and the body. */
export interface ResourceRequestContext {
  readonly session: UserPayload;
  readonly route: string;
  /** The connection the action runs against, for the audit event's connection fields. */
  readonly connection: ResourceAuditConnection;
}

function connectionAuditFields(connection: ResourceConnection): ResourceAuditConnection {
  return { id: connection.id, name: connection.name, type: connection.type };
}

/**
 * The inline `connection` field every fork resource route's body carries, or
 * a `connectionId` naming a stored or seeded one. `connectionId` wins when
 * both are present (the id names the record the server trusts; the inline
 * copy is discarded), the same precedence upstream's `resolveConnection` keeps.
 */
export function isResourceConnection(value: unknown): value is ResourceConnection {
  if (typeof value !== "object" || value === null) return false;
  return isResourceType((value as Record<string, unknown>).type);
}

const SEED_ID_PREFIX = "seed:";

/**
 * The connection a request runs against. Every miss a caller could probe with
 * — an unknown id, a seeded id its roles do not select, a seeded id that is
 * not there at all — answers the SAME 404, so nothing about which ids exist
 * leaks; the fork audit line is where an operator sees which id was asked
 * for. A seeded connection found but under-privileged for this route answers
 * 403 and leaves one failure outcome event on the fork trail.
 */
async function resolveResourceConnection(
  body: Record<string, unknown>,
  session: UserPayload,
  route: string,
  req: NextRequest,
): Promise<ResourceConnection> {
  const connectionId = body.connectionId;
  if (connectionId !== undefined) {
    if (typeof connectionId !== "string" || connectionId === "") {
      throw new ResourceRouteError("Invalid connection ID format");
    }
    if (connectionId.startsWith(SEED_ID_PREFIX)) {
      return resolveSeeded(session, route, req, connectionId.slice(SEED_ID_PREFIX.length));
    }
    return resolveStoredResourceConnection(connectionId);
  }

  const inline = body.connection;
  if (!isResourceConnection(inline)) {
    throw new ResourceRouteError("A resource connection with a valid resource type is required");
  }
  if (typeof inline.id === "string" && inline.id.startsWith(SEED_ID_PREFIX)) {
    throw new ResourceRouteError(
      `Connection ids starting with "${SEED_ID_PREFIX}" are reserved for preconfigured connections`,
    );
  }
  return inline;
}

async function resolveSeeded(
  session: UserPayload,
  route: string,
  req: NextRequest,
  seedId: string,
): Promise<ResourceConnection> {
  const opened = await openSeededResourceConnection(session, seedId);
  if (opened === null) {
    throw new ResourceNotFoundError("Resource connection not found: it does not exist or is not available to you");
  }
  const required = resourceRoutePermission(route);
  if (!permits(opened.permission, required)) {
    const error = new ResourceAccessDeniedError(opened.permission, required, opened.connection.name);
    recordSeededDenial(session, route, req, opened.connection, error);
    throw error;
  }
  // The seeded marker rides along, so the routes (and the workbenches after
  // them) can withhold write affordances below the connection's grant.
  const seededConnection: SeededResourceConnection = {
    ...opened.connection,
    seeded: true,
    permission: opened.permission,
  };
  return seededConnection;
}

/**
 * A seeded-connection denial's one audit line: the decision+outcome pair's
 * OUTCOME half with a locally minted correlation id, through the fork audit
 * API (the legacy fork recorded this denial by extending upstream's
 * `AuditReason` — P3 forbids that, so it rides the fork's own vocabulary
 * instead). Isolated like every fork emit: the 403 is already decided, and a
 * broken sink must not turn it into a 500.
 */
function recordSeededDenial(
  session: UserPayload,
  route: string,
  req: NextRequest,
  connection: ResourceConnection,
  error: ResourceAccessDeniedError,
): void {
  endResourceWrite(
    session.username,
    "resource.access.denied",
    `POST /${route}`,
    randomUUID(),
    error,
    req,
    connectionAuditFields(connection),
  );
}

async function readResourceBody(req: NextRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ResourceRouteError("Empty request body");
  }
  if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
    throw new ResourceRouteError("Empty request body");
  }
  return body;
}

/**
 * The fork's error → HTTP mapping: every `SB_*` refusal keeps its code and
 * status, and everything else delegates to upstream's `createErrorResponse`
 * (a `VaultError` from a seed reference, a rate-limit response's own shape).
 * Lives here rather than in upstream's api/errors.ts (P2/P3: no upstream edit).
 */
export function forkResourceErrorResponse(error: unknown, context?: { route?: string }): NextResponse {
  if (error instanceof ResourceRouteError) {
    return NextResponse.json(
      { error: error.message, code: error.code, statusCode: error.status },
      { status: error.status },
    );
  }
  if (error instanceof ResourceError) {
    return NextResponse.json(
      { error: error.message, code: error.code, statusCode: error.statusCode },
      { status: error.statusCode },
    );
  }
  return createErrorResponse(error, context);
}
