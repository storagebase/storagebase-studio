import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getForkStore, type ForkStore } from "@/lib/fork-store";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ResourceConflictError, ResourceInvalidRequestError, ResourceNotFoundError } from "@/lib/resources/errors";
import { isResourceType } from "@/lib/resources/types";
import { encryptConnections, encryptResourceConnections } from "@/lib/storage/connection-secrets";
import { readSecret } from "@/lib/storage/encryption";
import type { DatabaseConnection } from "@/lib/types";
import type { ResourceConnection } from "@/lib/resources/types";
import { roleKey } from "./permissions";
import { AccessStoreUnavailableError } from "./errors";
import { redactConfig, secretPaths } from "./redact";
import { ACCESS_PERMISSIONS, type ConnectionGroup, type ManagedConnectionRecord, type RoleBinding } from "./types";

/**
 * The access model's persistence (StorageBase fork): groups, bindings and managed connections as
 * records in the fork store (src/lib/fork-store), which lives on the same server storage
 * STORAGE_PROVIDER configures. With STORAGE_PROVIDER=local there is no server database, every
 * write here refuses with `AccessStoreUnavailableError`, and every read answers "nothing managed".
 *
 * Validation happens here, once, for the admin API and anything else that writes: a record that
 * reaches the store is always one the resolvers can read.
 */

const RECORD_KIND = {
  group: "access-group",
  binding: "access-binding",
  connection: "access-connection",
} as const;

/** A caller-chosen id: lowercase slug, so a deployment script can name groups and bind them in one pass. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_SCHEMA = z.string().min(1).max(64);
const OPTIONAL_SLUG = z.string().regex(SLUG, "An id is lowercase letters, digits and hyphens").optional();
const NAME_SCHEMA = z.string().trim().min(1, "A name is required").max(128);
/** Entra app-role values carry no whitespace; commas are refused because the audit trail joins values with them. */
const ROLE_VALUE_SCHEMA = z
  .string()
  .trim()
  .min(1, "An app-role value is required")
  .max(128)
  .regex(/^[^\s,]+$/, "An app-role value has no spaces or commas");
const DESCRIPTION_SCHEMA = z.string().trim().max(256).optional();
const GROUP_IDS_SCHEMA = z.array(ID_SCHEMA).max(64);
const CONFIG_SCHEMA = z.record(z.string(), z.unknown());
/** The bound on any one configuration string: generous for a PEM chain, bounded against a payload. */
const MAX_CONFIG_STRING = 65_536;

const GROUP_CREATE = z.object({ id: OPTIONAL_SLUG, name: NAME_SCHEMA, description: DESCRIPTION_SCHEMA });
const GROUP_UPDATE = z.object({ id: ID_SCHEMA, name: NAME_SCHEMA.optional(), description: DESCRIPTION_SCHEMA });
const BINDING_CREATE = z.object({
  appRoleValue: ROLE_VALUE_SCHEMA,
  groupId: ID_SCHEMA,
  permission: z.enum(ACCESS_PERMISSIONS as [string, ...string[]]),
});
const CONNECTION_CREATE = z.object({
  id: OPTIONAL_SLUG,
  kind: z.enum(["database", "resource"]),
  type: z.string(),
  name: NAME_SCHEMA,
  config: CONFIG_SCHEMA.default({}),
  groupIds: GROUP_IDS_SCHEMA.default([]),
});
const CONNECTION_UPDATE = z.object({
  id: ID_SCHEMA,
  name: NAME_SCHEMA.optional(),
  config: CONFIG_SCHEMA.optional(),
  groupIds: GROUP_IDS_SCHEMA.optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    throw new ResourceInvalidRequestError(path ? `${path}: ${issue.message}` : issue.message);
  }
  return result.data;
}

export async function openAccessStore(): Promise<ForkStore | null> {
  return getForkStore();
}

export async function requireAccessStore(): Promise<ForkStore> {
  const store = await getForkStore();
  if (!store) throw new AccessStoreUnavailableError();
  return store;
}

export interface AccessState {
  groups: ConnectionGroup[];
  bindings: RoleBinding[];
  connections: ManagedConnectionRecord[];
}

export const EMPTY_ACCESS_STATE: AccessState = { groups: [], bindings: [], connections: [] };

export async function loadAccessState(store: ForkStore): Promise<AccessState> {
  const [groups, bindings, connections] = await Promise.all([
    store.listRecords<ConnectionGroup>(RECORD_KIND.group),
    store.listRecords<RoleBinding>(RECORD_KIND.binding),
    store.listRecords<ManagedConnectionRecord>(RECORD_KIND.connection),
  ]);
  return { groups, bindings, connections };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Groups ─────────────────────────────────────────────────────────────────

function assertUniqueGroupName(groups: readonly ConnectionGroup[], name: string, exceptId?: string): void {
  if (groups.some((group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())) {
    throw new ResourceConflictError(`A group named "${name}" already exists`);
  }
}

export async function createGroup(input: unknown, actor: string): Promise<ConnectionGroup> {
  const store = await requireAccessStore();
  const data = parse(GROUP_CREATE, input);
  const groups = await store.listRecords<ConnectionGroup>(RECORD_KIND.group);
  const id = data.id ?? randomUUID();
  if (groups.some((group) => group.id === id))
    throw new ResourceConflictError(`A group with id "${id}" already exists`);
  assertUniqueGroupName(groups, data.name);
  const at = nowIso();
  const group: ConnectionGroup = {
    id,
    name: data.name,
    ...(data.description ? { description: data.description } : {}),
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
    updatedBy: actor,
  };
  await store.putRecord(RECORD_KIND.group, id, group, actor);
  return group;
}

export async function updateGroup(
  input: unknown,
  actor: string,
): Promise<{ before: ConnectionGroup; after: ConnectionGroup }> {
  const store = await requireAccessStore();
  const data = parse(GROUP_UPDATE, input);
  const groups = await store.listRecords<ConnectionGroup>(RECORD_KIND.group);
  const before = groups.find((group) => group.id === data.id);
  if (!before) throw new ResourceNotFoundError(`Group "${data.id}" not found`);
  if (data.name !== undefined) assertUniqueGroupName(groups, data.name, before.id);
  const after: ConnectionGroup = {
    ...before,
    name: data.name ?? before.name,
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  if (data.description !== undefined) {
    if (data.description) after.description = data.description;
    else delete after.description;
  }
  await store.putRecord(RECORD_KIND.group, after.id, after, actor);
  return { before, after };
}

/** Deletes a group, its bindings, and its membership on every connection. */
export async function deleteGroup(
  id: unknown,
  actor: string,
): Promise<{ group: ConnectionGroup; removedBindings: number; detachedConnections: number }> {
  const store = await requireAccessStore();
  const groupId = parse(ID_SCHEMA, id);
  const state = await loadAccessState(store);
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new ResourceNotFoundError(`Group "${groupId}" not found`);

  const bindings = state.bindings.filter((binding) => binding.groupId === groupId);
  for (const binding of bindings) await store.deleteRecord(RECORD_KIND.binding, binding.id);
  const members = state.connections.filter((connection) => connection.groupIds.includes(groupId));
  for (const connection of members) {
    const detached = {
      ...connection,
      groupIds: connection.groupIds.filter((candidate) => candidate !== groupId),
      updatedAt: nowIso(),
      updatedBy: actor,
    };
    await store.putRecord(RECORD_KIND.connection, connection.id, detached, actor);
  }
  await store.deleteRecord(RECORD_KIND.group, groupId);
  return { group, removedBindings: bindings.length, detachedConnections: members.length };
}

// ─── Bindings ───────────────────────────────────────────────────────────────

/**
 * Creates a binding, or changes the permission of the one that already binds this role value to
 * this group — so a deployment script can re-run and converge instead of piling up duplicates.
 */
export async function createBinding(
  input: unknown,
  actor: string,
): Promise<{ binding: RoleBinding; replaced: RoleBinding | null }> {
  const store = await requireAccessStore();
  const data = parse(BINDING_CREATE, input);
  const [groups, bindings] = await Promise.all([
    store.listRecords<ConnectionGroup>(RECORD_KIND.group),
    store.listRecords<RoleBinding>(RECORD_KIND.binding),
  ]);
  if (!groups.some((group) => group.id === data.groupId)) {
    throw new ResourceInvalidRequestError(`groupId: group "${data.groupId}" does not exist`);
  }
  const replaced =
    bindings.find(
      (binding) => binding.groupId === data.groupId && roleKey(binding.appRoleValue) === roleKey(data.appRoleValue),
    ) ?? null;
  const binding: RoleBinding = {
    id: replaced?.id ?? randomUUID(),
    appRoleValue: data.appRoleValue,
    groupId: data.groupId,
    permission: data.permission as RoleBinding["permission"],
    createdAt: nowIso(),
    createdBy: actor,
  };
  await store.putRecord(RECORD_KIND.binding, binding.id, binding, actor);
  return { binding, replaced };
}

export async function deleteBinding(id: unknown): Promise<RoleBinding> {
  const store = await requireAccessStore();
  const bindingId = parse(ID_SCHEMA, id);
  const bindings = await store.listRecords<RoleBinding>(RECORD_KIND.binding);
  const binding = bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) throw new ResourceNotFoundError(`Binding "${bindingId}" not found`);
  await store.deleteRecord(RECORD_KIND.binding, bindingId);
  return binding;
}

// ─── Managed connections ────────────────────────────────────────────────────

/** The configuration keys that hold a nested group of fields (TLS, SSH tunnel). */
const NESTED_CONTAINERS: ReadonlySet<string> = new Set(["ssl", "sshTunnel"]);

/** The identity keys a record keeps beside its config, never inside it. */
const IDENTITY_KEYS = new Set(["id", "name", "type", "createdAt", "managed", "seedId", "agentUser", "agentPassword"]);

function assertType(kind: ManagedConnectionRecord["kind"], type: string): void {
  const known =
    kind === "database" ? (SHIPPED_DATABASE_TYPES as readonly string[]).includes(type) : isResourceType(type);
  if (!known) throw new ResourceInvalidRequestError(`type: "${type}" is not a ${kind} type`);
}

function assertGroupsExist(groups: readonly ConnectionGroup[], groupIds: readonly string[]): void {
  const known = new Set(groups.map((group) => group.id));
  const missing = groupIds.find((groupId) => !known.has(groupId));
  if (missing !== undefined) throw new ResourceInvalidRequestError(`groupIds: group "${missing}" does not exist`);
}

/** A configuration value this store will keep: bounded strings, finite numbers, booleans. */
function scalar(path: string, value: unknown): string | number | boolean {
  if (typeof value === "string") {
    if (value.length > MAX_CONFIG_STRING) throw new ResourceInvalidRequestError(`config.${path}: value is too long`);
    return value;
  }
  if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") return value;
  throw new ResourceInvalidRequestError(`config.${path}: must be a string, number or boolean`);
}

/**
 * The submitted configuration reduced to what a connection of this kind can hold, with the secret
 * fields split out: `public` is the new configuration, `secrets` maps a secret path to its new
 * plaintext, or to null to clear it. A blank or absent secret is "keep what is stored".
 */
function splitConfig(
  kind: ManagedConnectionRecord["kind"],
  config: Record<string, unknown>,
): { publicConfig: Record<string, unknown>; secrets: Map<string, string | null> } {
  const secretSet = new Set(secretPaths(kind));
  const secrets = new Map<string, string | null>();
  const withoutIdentity = Object.fromEntries(Object.entries(config).filter(([key]) => !IDENTITY_KEYS.has(key)));
  const { config: publicShape } = redactConfig(kind, withoutIdentity);

  const publicConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(publicShape)) {
    if (value === null || value === undefined) continue;
    // `redactConfig` keeps a container only as an object; any other object value is refused below.
    if (NESTED_CONTAINERS.has(key)) {
      const nested: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (nestedValue === null || nestedValue === undefined) continue;
        nested[nestedKey] = scalar(`${key}.${nestedKey}`, nestedValue);
      }
      publicConfig[key] = nested;
    } else {
      publicConfig[key] = scalar(key, value);
    }
  }

  const collect = (path: string, value: unknown) => {
    if (!secretSet.has(path)) return;
    if (value === null) secrets.set(path, null);
    else if (typeof value === "string" && value.length > 0) secrets.set(path, scalar(path, value) as string);
  };
  for (const [key, value] of Object.entries(withoutIdentity)) {
    if (typeof value === "object" && value !== null) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        collect(`${key}.${nestedKey}`, nestedValue);
      }
    } else {
      collect(key, value);
    }
  }
  return { publicConfig, secrets };
}

function readPath(config: Record<string, unknown>, path: string): unknown {
  const [head, tail] = path.split(".");
  if (tail === undefined) return config[head];
  const nested = config[head];
  return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>)[tail] : undefined;
}

function writePath(config: Record<string, unknown>, path: string, value: string): void {
  const [head, tail] = path.split(".");
  if (tail === undefined) {
    config[head] = value;
    return;
  }
  // A nested secret needs its container: SSL material without an `ssl` block, or a tunnel key
  // without a `sshTunnel` block, would be a credential for a transport the connection never uses.
  const nested = config[head];
  if (typeof nested === "object" && nested !== null) (nested as Record<string, unknown>)[tail] = value;
}

/** Seals the configuration's secrets with the storage encryption; identity is only a carrier here. */
function seal(record: Pick<ManagedConnectionRecord, "id" | "kind" | "type" | "name">, config: Record<string, unknown>) {
  const carrier = { ...config, id: record.id, name: record.name, type: record.type, createdAt: nowIso() };
  const sealed =
    record.kind === "database"
      ? (encryptConnections([carrier as unknown as DatabaseConnection])[0] as unknown as Record<string, unknown>)
      : (encryptResourceConnections([carrier as unknown as ResourceConnection])[0] as unknown as Record<
          string,
          unknown
        >);
  return Object.fromEntries(Object.entries(sealed).filter(([key]) => !IDENTITY_KEYS.has(key)));
}

/**
 * The new stored configuration: the submitted public fields, the submitted secrets, and every
 * stored secret the submission left blank — unless it no longer opens under the current key, in
 * which case it is dropped rather than re-sealed as if its ciphertext were a password.
 */
function mergeConfig(
  kind: ManagedConnectionRecord["kind"],
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  const { publicConfig, secrets } = splitConfig(kind, submitted);
  for (const path of secretPaths(kind)) {
    const next = secrets.get(path);
    if (next === null) continue;
    if (next !== undefined) {
      writePath(publicConfig, path, next);
      continue;
    }
    const kept = readPath(stored, path);
    if (typeof kept === "string" && kept.length > 0 && readSecret(kept).kind !== "undecryptable") {
      writePath(publicConfig, path, kept);
    }
  }
  return publicConfig;
}

export async function createManagedConnection(input: unknown, actor: string): Promise<ManagedConnectionRecord> {
  const store = await requireAccessStore();
  const data = parse(CONNECTION_CREATE, input);
  assertType(data.kind, data.type);
  const state = await loadAccessState(store);
  assertGroupsExist(state.groups, data.groupIds);
  const id = data.id ?? randomUUID();
  if (state.connections.some((connection) => connection.id === id)) {
    throw new ResourceConflictError(`A managed connection with id "${id}" already exists`);
  }
  const at = nowIso();
  const identity = { id, kind: data.kind, type: data.type, name: data.name };
  const record: ManagedConnectionRecord = {
    ...identity,
    config: seal(identity, mergeConfig(data.kind, {}, data.config)),
    groupIds: [...new Set(data.groupIds)],
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
    updatedBy: actor,
  };
  await store.putRecord(RECORD_KIND.connection, id, record, actor);
  return record;
}

export async function updateManagedConnection(
  input: unknown,
  actor: string,
): Promise<{ before: ManagedConnectionRecord; after: ManagedConnectionRecord }> {
  const store = await requireAccessStore();
  const data = parse(CONNECTION_UPDATE, input);
  const state = await loadAccessState(store);
  const before = state.connections.find((connection) => connection.id === data.id);
  if (!before) throw new ResourceNotFoundError(`Managed connection "${data.id}" not found`);
  if (data.groupIds !== undefined) assertGroupsExist(state.groups, data.groupIds);
  const name = data.name ?? before.name;
  const config =
    data.config === undefined
      ? before.config
      : seal({ ...before, name }, mergeConfig(before.kind, before.config, data.config));
  const after: ManagedConnectionRecord = {
    ...before,
    name,
    config,
    groupIds: data.groupIds === undefined ? before.groupIds : [...new Set(data.groupIds)],
    updatedAt: nowIso(),
    updatedBy: actor,
  };
  await store.putRecord(RECORD_KIND.connection, after.id, after, actor);
  return { before, after };
}

export async function deleteManagedConnection(id: unknown): Promise<ManagedConnectionRecord> {
  const store = await requireAccessStore();
  const connectionId = parse(ID_SCHEMA, id);
  const connections = await store.listRecords<ManagedConnectionRecord>(RECORD_KIND.connection);
  const record = connections.find((candidate) => candidate.id === connectionId);
  if (!record) throw new ResourceNotFoundError(`Managed connection "${connectionId}" not found`);
  await store.deleteRecord(RECORD_KIND.connection, connectionId);
  return record;
}

/** A record's configuration merged with a submission, WITHOUT saving: what "test connection" runs against. */
export function previewManagedConfig(
  kind: ManagedConnectionRecord["kind"],
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  return mergeConfig(kind, stored, submitted);
}
