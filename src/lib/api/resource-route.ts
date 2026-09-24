import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { isResourceType, type ResourceConnection } from "@/lib/resources/types";
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
 * The body carries the resource connection INLINE as `connection` — the same
 * contract user-owned database connections use, because resource connections
 * live in the same write-through localStorage store. Managed `seed:`-style
 * resource ids are M6; when they land they resolve here, beside the parse, and
 * nowhere else.
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
    if (!isResourceConnection(body.connection)) {
      return NextResponse.json(
        { error: "A resource connection with a valid resource type is required" },
        { status: 400 },
      );
    }
    return await run(body.connection, body, { session: guard.session, route, connection: body.connection });
  } catch (error) {
    if (error instanceof ResourceRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return createErrorResponse(error, { route });
  }
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
 * A refusal this layer decides for itself. 400 only: a caller mistake the
 * provider must never be asked to interpret. Kept parallel to
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
