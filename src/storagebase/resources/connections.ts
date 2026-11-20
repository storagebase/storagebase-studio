import { randomUUID } from "node:crypto";
import { getForkStore } from "@/storagebase/store";
import { removeResourceProvider } from "./factory";
import {
  ResourceNotFoundError,
  ResourceRouteError,
  ResourceSeedReadOnlyError,
  ResourceStoreUnavailableError,
} from "./errors";
import {
  openSealedResourceConnection,
  resourceConnectionRow,
  SEALABLE_FIELDS,
  sealResourceConnection,
  sealResourceSecretFields,
} from "./sealing";
import {
  isResourceType,
  type ResourceConnection,
  type ResourceConnectionRow,
  type ResourcePermission,
  type ResourceType,
} from "./types";

/**
 * User-created resource connections, persisted through the fork store as
 * records of kind `"resource-connection"` (STORAGEBASE.md P3: upstream's
 * storage collections are never extended). Every write seals the connection's
 * secret fields first (`sealing.ts`); every read for a REQUEST opens them
 * server-side only; every read for the BROWSER goes through
 * `resourceConnectionRow`, which whitelists non-secret fields and answers a
 * boolean "has credential" marker instead.
 *
 * When the fork store is not configured (`getForkStore()` answers null,
 * STORAGE_PROVIDER=local) the mutation paths refuse with
 * `SB_STORE_UNAVAILABLE` rather than pretending a write landed, and the list
 * path serves the seed file's rows alone — those need no store.
 *
 * The record is shared, deployment-wide: the fork store has no per-user
 * scoping, so a stored connection is everyone's to use. Creating, changing and
 * deleting one is therefore an ADMIN action (the routes enforce the role; a
 * `user` still tests and uses connections, including their own unsaved ones
 * through the inline path). Seeded rows are read-only by construction and
 * refused here before any store access.
 */
export const RESOURCE_CONNECTION_KIND = "resource-connection";

/** What the store holds: a ResourceConnection whose secret fields are sealed envelopes, plus bookkeeping. */
export interface StoredResourceConnection extends ResourceConnection {
  /** The creator-set grant every user of the record is bounded by; always present on a stored record. */
  permission: ResourcePermission;
  updatedAt: string;
  updatedBy: string;
}

/** The ids the create path mints, so a stored id can never collide with the seed namespace. */
export const STORED_CONNECTION_ID_PREFIX = "res_";

/** The permission levels a definer may grant; validated on intake, defaulted to least privilege. */
const PERMISSION_LEVELS: ReadonlySet<string> = new Set(["read", "write", "admin"]);

/** The grant a record without one gets: least privilege, never a silent full grant. */
const DEFAULT_STORED_PERMISSION: ResourcePermission = "read";

/** The connection a create or update body stands for: identity fields excluded, the rest validated strings. */
export interface ResourceConnectionInput {
  name: string;
  type: ResourceType;
  /** The creator-set grant; omitted means least privilege (`read`). */
  permission?: ResourcePermission;
  color?: string;
  environment?: string;
  group?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  connectionString?: string;
  token?: string;
  password?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  accountKey?: string;
  sasUrl?: string;
  authMode?: string;
  vaultName?: string;
  namespace?: string;
}

/** The optional input fields that are NOT secrets — the update path replaces exactly these. */
const NON_SECRET_INPUT_FIELDS = [
  "color",
  "environment",
  "group",
  "endpoint",
  "region",
  "accessKeyId",
  "tenantId",
  "clientId",
  "vaultName",
  "namespace",
] as const;

/** The optional fields a create/update body may carry: the non-secret ones above, plus every sealable secret field. */
const OPTIONAL_INPUT_FIELDS = [...NON_SECRET_INPUT_FIELDS, ...SEALABLE_FIELDS] as const;

/** The input's non-secret fields, present ones only. */
function nonSecretInputOf(input: ResourceConnectionInput): Partial<ResourceConnection> {
  const carried: { [K in (typeof NON_SECRET_INPUT_FIELDS)[number]]?: string } = {};
  for (const field of NON_SECRET_INPUT_FIELDS) {
    const value = input[field];
    if (typeof value === "string") carried[field] = value;
  }
  return carried;
}

/** The sealed envelopes a stored record holds, exactly as stored (never re-sealed). */
function sealedSecretsOf(record: ResourceConnection): Partial<Record<(typeof SEALABLE_FIELDS)[number], string>> {
  const carried: Partial<Record<(typeof SEALABLE_FIELDS)[number], string>> = {};
  for (const field of SEALABLE_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value !== "") carried[field] = value;
  }
  return carried;
}

function mintConnectionId(): string {
  return `${STORED_CONNECTION_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

/**
 * Reads a caller-supplied connection record (create or update body) and
 * returns the whitelisted input it stands for — or the route error that names
 * what is wrong with it. The whitelist is the whole intake story: a field the
 * fork does not know is not stored; `sshTunnel` gets its own refusal sentence
 * until a provider family actually uses it (phases 3-4 flip that), because
 * silently dropping a field a user typed would look like a saved setting that
 * never took effect; and an id claiming the `seed:` namespace is refused
 * outright — the id is the server's to mint (create) or the URL's to name
 * (update), never the body's.
 */
export function readResourceConnectionInput(
  value: unknown,
): { ok: true; input: ResourceConnectionInput } | { ok: false; error: ResourceRouteError } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: new ResourceRouteError("A resource connection object is required") };
  }
  const record = value as Record<string, unknown>;
  const { name, type, sshTunnel, id } = record;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: new ResourceRouteError('A resource connection requires a non-empty "name"') };
  }
  if (!isResourceType(type)) {
    return { ok: false, error: new ResourceRouteError('A resource connection requires a valid resource "type"') };
  }
  if (typeof id === "string" && id.startsWith("seed:")) {
    return {
      ok: false,
      error: new ResourceRouteError('Connection ids starting with "seed:" are reserved for preconfigured connections'),
    };
  }
  if (sshTunnel !== undefined) {
    return {
      ok: false,
      error: new ResourceRouteError(
        "sshTunnel is not supported for stored resource connections yet; it arrives with the provider families that use it",
      ),
    };
  }

  const input: ResourceConnectionInput = { name: name.trim(), type };
  if (record.permission !== undefined) {
    if (typeof record.permission !== "string" || !PERMISSION_LEVELS.has(record.permission)) {
      return {
        ok: false,
        error: new ResourceRouteError('"permission" must be one of "read", "write" or "admin"'),
      };
    }
    input.permission = record.permission as ResourcePermission;
  }
  for (const field of OPTIONAL_INPUT_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === "") continue;
    if (typeof raw !== "string") {
      return { ok: false, error: new ResourceRouteError(`Connection field "${field}" must be a string`) };
    }
    input[field] = raw;
  }
  return { ok: true, input };
}

/** One stored record as the connection list serves it: non-secret fields plus the has-credential marker. */
export function storedResourceRow(record: StoredResourceConnection): ResourceConnectionRow {
  return resourceConnectionRow(record);
}

/** Every stored record, in id order. An unavailable store answers none; `resourceStoreAvailable` says why the list can be empty. */
export async function listStoredResourceConnections(): Promise<StoredResourceConnection[]> {
  const store = await getForkStore();
  if (store === null) return [];
  return store.listRecords<StoredResourceConnection>(RESOURCE_CONNECTION_KIND);
}

/** Whether the fork store can hold connections at all — the list route's honest sentence about the stored half. */
export async function resourceStoreAvailable(): Promise<boolean> {
  return (await getForkStore()) !== null;
}

/** The uniform 404 for a stored connection that is not there. */
function storedConnectionNotFound(): ResourceNotFoundError {
  return new ResourceNotFoundError("Resource connection not found: it does not exist or is not available to you");
}

async function requireStore() {
  const store = await getForkStore();
  if (store === null) throw new ResourceStoreUnavailableError();
  return store;
}

async function findStored(id: string): Promise<StoredResourceConnection> {
  const store = await getForkStore();
  if (store === null) throw new ResourceStoreUnavailableError();
  const records = await store.listRecords<StoredResourceConnection>(RESOURCE_CONNECTION_KIND);
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) throw storedConnectionNotFound();
  return record;
}

/**
 * Creates a connection: the server mints the id (a caller never chooses one, so
 * no id can squat the seed namespace or shadow another record), seals every
 * secret field BEFORE the record reaches the store, and answers the record
 * the browser may hold through `storedResourceRow`.
 */
export async function createStoredResourceConnection(
  input: ResourceConnectionInput,
  actor: string,
): Promise<StoredResourceConnection> {
  const store = await requireStore();
  const id = mintConnectionId();
  const now = new Date().toISOString();
  const sealed = sealResourceConnection({ ...input, id, createdAt: now });
  const record: StoredResourceConnection = {
    ...sealed,
    permission: input.permission ?? DEFAULT_STORED_PERMISSION,
    updatedAt: now,
    updatedBy: actor,
  };
  await store.putRecord(RESOURCE_CONNECTION_KIND, id, record, actor);
  return record;
}

/**
 * Replaces a stored connection's non-secret fields and re-seals the secret
 * ones it is given. A secret field that arrives empty or absent KEEPS the
 * stored envelope — the edit form never echoes a secret back, so "left blank"
 * is its only honest meaning; dropping one would silently clear credentials
 * the operator never asked to clear (removing a credential means re-creating
 * the connection, documented in docs/storagebase/resources/README.md).
 *
 * A seeded id is refused before any store access; the provider cache entry
 * for the id is dropped either way, so the next request rebuilds from what
 * the store now holds.
 */
export async function updateStoredResourceConnection(
  id: string,
  input: ResourceConnectionInput,
  actor: string,
): Promise<StoredResourceConnection> {
  if (id.startsWith("seed:")) throw new ResourceSeedReadOnlyError(id);
  const existing = await findStored(id);
  const now = new Date().toISOString();

  // The kept envelopes are NOT re-sealed; only the freshly typed values are.
  const secrets = { ...sealedSecretsOf(existing), ...sealResourceSecretFields(input) };
  const record: StoredResourceConnection = {
    id,
    name: input.name,
    type: input.type,
    createdAt: existing.createdAt,
    // An edit that does not carry a grant keeps the one the definer set; a record from before this
    // field existed gets least privilege rather than the old unrestricted default.
    permission: input.permission ?? existing.permission ?? DEFAULT_STORED_PERMISSION,
    ...nonSecretInputOf(input),
    ...secrets,
    updatedAt: now,
    updatedBy: actor,
  };
  const store = await requireStore();
  await store.putRecord(RESOURCE_CONNECTION_KIND, id, record, actor);
  await removeResourceProvider(id).catch(() => undefined);
  return record;
}

/**
 * Deletes a stored connection; a seeded id is refused first, and a missing id
 * is not an error (the store's own ruling). The cached provider, if any, is
 * closed so nothing keeps serving a deleted connection's client.
 */
export async function deleteStoredResourceConnection(id: string): Promise<void> {
  if (id.startsWith("seed:")) throw new ResourceSeedReadOnlyError(id);
  const store = await requireStore();
  await store.deleteRecord(RESOURCE_CONNECTION_KIND, id);
  await removeResourceProvider(id).catch(() => undefined);
}

/**
 * The stored connection a request opens, secrets decrypted server-side. A
 * sealed value this key cannot open is a `ResourceConfigError` naming the
 * field (sealing.ts), not a silent empty field an authentication failure
 * would have to explain.
 */
export async function resolveStoredResourceConnection(id: string): Promise<ResourceConnection> {
  const record = await findStored(id);
  return openSealedResourceConnection(record);
}

/**
 * The stored connection a request opens, WITH the grant its definer set, so the
 * request layer can answer 403 before any provider work (and so the route's
 * caller can attach the grant to the connection, which is what withholds the
 * UI's write affordances). A record written before the grant existed answers
 * least privilege (`read`) — never an implicit full grant.
 */
export async function resolveStoredResourceWithGrant(
  id: string,
): Promise<{ connection: ResourceConnection; permission: ResourcePermission }> {
  const record = await findStored(id);
  const permission = record.permission ?? DEFAULT_STORED_PERMISSION;
  const connection = openSealedResourceConnection(record);
  return { connection: { ...connection, permission }, permission };
}
