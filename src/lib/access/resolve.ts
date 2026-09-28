import { getForkStore } from "@/lib/fork-store";
import { logger } from "@/lib/logger";
import { decryptConnections, decryptResourceConnections } from "@/lib/storage/connection-secrets";
import type { DatabaseConnection } from "@/lib/types";
import type { ResourceConnection } from "@/lib/resources/types";
import { auditAccessDenial, recordManagedUse } from "./audit";
import { attachGrant, type ManagedGrant } from "./grant";
import { evaluateAccess } from "./permissions";
import { accessSubject, type SessionLike } from "./session";
import { loadAccessState, type AccessState } from "./store";
import type { AccessPermission, ManagedConnectionKind, ManagedConnectionRecord } from "./types";

/**
 * Managed connections, as a signed-in user reaches them (StorageBase fork).
 *
 * Two id spaces, one per layer, each parallel to what that layer already speaks:
 * - a managed DATABASE connection is served as a seed row whose `seedId` is `m_<record id>`, so the
 *   browser's existing managed-seed path (`{ connectionId: "seed:m_<id>" }`, no edit, no
 *   duplicate, no delete) carries it with no client change. The underscore keeps the space
 *   disjoint from Helm seed ids, which the seed schema restricts to `[a-z0-9-]`.
 * - a managed RESOURCE connection is served with `id: "managed:<record id>"`, and the browser sends
 *   `{ connectionId: "managed:<id>" }` in place of the inline connection.
 *
 * What a user is served is PRESENTATION only: name, type, environment, colour, the database/schema
 * a database connection opens, and the permission they hold. Never a host, a user name, an
 * endpoint, a key id, a certificate or a credential: the owner's rule is that a preconfigured
 * connection is usable but not viewable. The configuration is decrypted only on the server, only
 * for a caller the bindings admit, and only for the request at hand.
 */

export const MANAGED_SEED_PREFIX = "m_";
export const MANAGED_RESOURCE_PREFIX = "managed:";

/** The owner's decision: Studio administrators may use every managed connection, audited as `admin-bypass`. */
const ADMIN_BYPASS = true;

/** Presentation fields a user may see of a managed database connection. */
const DATABASE_PRESENTATION = ["database", "schema", "environment", "color", "group", "skipObjectScan"] as const;
/** Presentation fields a user may see of a managed resource connection. */
const RESOURCE_PRESENTATION = ["environment", "color", "group"] as const;

function pick(config: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}

function grantFor(session: SessionLike, record: ManagedConnectionRecord, state: AccessState): ManagedGrant | null {
  const grant = evaluateAccess(accessSubject(session), record.groupIds, state.bindings, { adminBypass: ADMIN_BYPASS });
  if (!grant) return null;
  const names = new Map(state.groups.map((group) => [group.id, group.name]));
  return { ...grant, groupNames: grant.groupIds.map((id) => names.get(id) ?? id) };
}

/** The names of every group a connection belongs to (not only the granting ones), for display. */
function memberGroupNames(record: ManagedConnectionRecord, state: AccessState): string[] {
  const names = new Map(state.groups.map((group) => [group.id, group.name]));
  return record.groupIds.map((id) => names.get(id)).filter((name): name is string => name !== undefined);
}

async function readState(): Promise<AccessState | null> {
  const store = await getForkStore();
  return store ? loadAccessState(store) : null;
}

export interface VisibleManagedConnection {
  record: ManagedConnectionRecord;
  grant: ManagedGrant;
  groupNames: string[];
}

/** The managed connections of one kind this caller may use, with the grant for each. */
export function visibleConnections(
  session: SessionLike,
  state: AccessState,
  kind: ManagedConnectionKind,
): VisibleManagedConnection[] {
  const out: VisibleManagedConnection[] = [];
  for (const record of state.connections) {
    if (record.kind !== kind) continue;
    const grant = grantFor(session, record, state);
    if (grant) out.push({ record, grant, groupNames: memberGroupNames(record, state) });
  }
  return out.sort((a, b) => a.record.name.localeCompare(b.record.name));
}

// ─── Database connections (through the seed pipeline) ──────────────────────

/** A managed database connection as `GET /api/connections/managed` serves it. */
export interface ManagedDatabaseRow {
  id: string;
  seedId: string;
  name: string;
  type: string;
  createdAt: string;
  managed: true;
  roles: string[];
  permission: AccessPermission;
  groupNames: string[];
  [presentation: string]: unknown;
}

function managedDatabaseRow(visible: VisibleManagedConnection): ManagedDatabaseRow {
  const { record, grant, groupNames } = visible;
  return {
    ...pick(record.config, DATABASE_PRESENTATION),
    id: `seed:${MANAGED_SEED_PREFIX}${record.id}`,
    seedId: `${MANAGED_SEED_PREFIX}${record.id}`,
    name: record.name,
    type: record.type,
    createdAt: record.createdAt,
    managed: true,
    roles: [],
    permission: grant.permission,
    groupNames,
  };
}

/**
 * The rows `GET /api/connections/managed` appends to the seed list. Empty — never an error — when
 * the deployment has no server storage (then there is nothing managed to serve) or its store
 * cannot be read.
 */
export async function listManagedDatabaseRows(session: SessionLike): Promise<ManagedDatabaseRow[]> {
  try {
    const state = await readState();
    if (!state) return [];
    return visibleConnections(session, state, "database").map(managedDatabaseRow);
  } catch (error) {
    // Fails closed and stays out of the seed list's own failure: an unreadable access store lists
    // no managed connection, and the seeds the file serves still arrive.
    logger.error("Failed to read managed database connections", error, { route: "access/resolve" });
    return [];
  }
}

/**
 * Resolves `seed:m_<id>` for `resolveConnection`. Null for any other seed id (a Helm seed, which the
 * upstream path resolves) AND for a managed id this caller may not use or that does not exist —
 * the upstream path then answers 404 for both alike, so a non-member cannot tell them apart.
 */
export async function resolveManagedDatabaseSeed(
  seedId: string,
  session: SessionLike,
): Promise<DatabaseConnection | null> {
  if (!seedId.startsWith(MANAGED_SEED_PREFIX)) return null;
  const state = await readState();
  if (!state) return null;
  const id = seedId.slice(MANAGED_SEED_PREFIX.length);
  const record = state.connections.find((candidate) => candidate.kind === "database" && candidate.id === id);
  if (!record) return null;
  const grant = grantFor(session, record, state);
  const connectionId = `seed:${seedId}`;
  if (!grant) {
    auditAccessDenial({ session, target: connectionId, reason: "access_not_granted" });
    return null;
  }
  const carrier = {
    ...record.config,
    id: connectionId,
    name: record.name,
    type: record.type,
    createdAt: record.createdAt,
  };
  const [opened] = decryptConnections([carrier as unknown as DatabaseConnection]).connections;
  const connection: DatabaseConnection = {
    ...opened,
    createdAt: new Date(record.createdAt),
    managed: true,
    seedId,
  };
  attachGrant(connection, grant);
  recordManagedUse(session, connection);
  return connection;
}

// ─── Resource connections ───────────────────────────────────────────────────

/** A managed resource connection as `GET /api/resources/managed` serves it. */
export interface ManagedResourceRow {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  managed: true;
  permission: AccessPermission;
  groupNames: string[];
  environment?: string;
  color?: string;
  group?: string;
}

function managedResourceRow(visible: VisibleManagedConnection): ManagedResourceRow {
  const { record, grant, groupNames } = visible;
  return {
    ...(pick(record.config, RESOURCE_PRESENTATION) as Pick<ManagedResourceRow, "environment" | "color" | "group">),
    id: `${MANAGED_RESOURCE_PREFIX}${record.id}`,
    name: record.name,
    type: record.type,
    createdAt: record.createdAt,
    managed: true,
    permission: grant.permission,
    groupNames,
  };
}

export async function listManagedResourceRows(session: SessionLike): Promise<ManagedResourceRow[]> {
  const state = await readState();
  if (!state) return [];
  return visibleConnections(session, state, "resource").map(managedResourceRow);
}

/**
 * Resolves `managed:<id>` for the resource routes, or null when it does not exist or the caller may
 * not use it (answered 404 either way). The resolved connection carries its grant.
 */
export async function resolveManagedResource(
  connectionId: string,
  session: SessionLike,
): Promise<ResourceConnection | null> {
  if (!connectionId.startsWith(MANAGED_RESOURCE_PREFIX)) return null;
  const state = await readState();
  if (!state) return null;
  const id = connectionId.slice(MANAGED_RESOURCE_PREFIX.length);
  const record = state.connections.find((candidate) => candidate.kind === "resource" && candidate.id === id);
  if (!record) return null;
  const grant = grantFor(session, record, state);
  if (!grant) {
    auditAccessDenial({ session, target: connectionId, reason: "access_not_granted" });
    return null;
  }
  const carrier = {
    ...record.config,
    id: connectionId,
    name: record.name,
    type: record.type,
    createdAt: record.createdAt,
  };
  const [connection] = decryptResourceConnections([carrier as unknown as ResourceConnection]).resourceConnections;
  attachGrant(connection, grant);
  recordManagedUse(session, connection);
  return connection;
}
