import { NextResponse, type NextRequest } from "next/server";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { createErrorResponse } from "@/lib/api/errors";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { redactConfig } from "./redact";
import { MANAGED_RESOURCE_PREFIX, MANAGED_SEED_PREFIX } from "./resolve";
import type { AccessState } from "./store";
import type { ManagedConnectionRecord } from "./types";

/**
 * Shared plumbing for the admin access API under /api/admin/access (StorageBase fork): the admin
 * gate (session, rate limit, role, each denial audited) before anything is parsed, one error
 * mapping, and the one view of a managed connection an administrator is ever shown.
 */

export type AdminSession = { role: string; username: string };

export async function adminAccessRoute(
  request: NextRequest,
  route: string,
  run: (session: AdminSession) => Promise<NextResponse>,
): Promise<NextResponse> {
  const guard = await guardAdminRoute(request, route);
  if ("response" in guard) return guard.response;
  try {
    return await run(guard.session);
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}

export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ResourceInvalidRequestError("The request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ResourceInvalidRequestError("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** The `id` a DELETE names in its query string. */
export function queryId(request: NextRequest): string {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) throw new ResourceInvalidRequestError('The "id" query parameter is required');
  return id;
}

export interface AdminConnectionView {
  id: string;
  kind: ManagedConnectionRecord["kind"];
  type: string;
  name: string;
  /** The id a user's browser addresses it by: `seed:m_<id>` or `managed:<id>`. */
  clientId: string;
  groupIds: string[];
  groupNames: string[];
  /** The configuration with every credential removed. */
  config: Record<string, unknown>;
  /** Which credentials are set ("leave blank to keep"). */
  secretsSet: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export function adminConnectionView(
  record: ManagedConnectionRecord,
  state: Pick<AccessState, "groups">,
): AdminConnectionView {
  const names = new Map(state.groups.map((group) => [group.id, group.name]));
  const { config, secretsSet } = redactConfig(record.kind, record.config);
  return {
    id: record.id,
    kind: record.kind,
    type: record.type,
    name: record.name,
    clientId:
      record.kind === "database" ? `seed:${MANAGED_SEED_PREFIX}${record.id}` : `${MANAGED_RESOURCE_PREFIX}${record.id}`,
    groupIds: record.groupIds,
    groupNames: record.groupIds.map((id) => names.get(id) ?? id),
    config,
    secretsSet,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}
