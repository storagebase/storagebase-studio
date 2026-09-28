import { getForkStore, type ForkStore } from "@/lib/fork-store";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { logger } from "@/lib/logger";
import { ResourceConflictError, ResourceError, ResourceInvalidRequestError } from "@/lib/resources/errors";
import { isResourceType } from "@/lib/resources/types";
import { getStorageProvider } from "@/lib/storage/factory";
import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";
import { auditSecretsMigrated } from "./audit";
import { parseUserConnectionId, type UserConnectionFamily } from "./ids";
import { absorbSecrets, heldPaths } from "./provider";
import { extractSecrets, targetFingerprint, withSecrets, type ConnectionRow, type SecretBag } from "./secrets";
import {
  deleteSecretRecord,
  loadSecretRecords,
  openSecrets,
  putSecretRecord,
  sealSecrets,
  type UserSecretRecord,
} from "./store";

/**
 * A user's own connections with server-held credentials (StorageBase fork): the save, the
 * "test before save" preview, the forget, the one-time migration of a browser's copies, and the
 * resolution every database and resource route runs for `user:<id>`.
 *
 * The public fields of a connection live in the user's synced collection (the server's copy of
 * it); its secrets live in the write-only store (./store.ts), bound to the target they were saved
 * for. Nothing here returns a secret to a caller that answers a browser: `saveUserConnection` and
 * `migrateUserConnections` answer rows carrying only `savedSecrets`, the list of paths held.
 */

// Single-line, hoisted: bun's line coverage under-counts a wrapped string's continuation lines.
export const USER_STORE_UNAVAILABLE_MESSAGE =
  "Saving connection credentials on the server needs server storage: set STORAGE_PROVIDER to sqlite or postgres.";
export const TARGET_CHANGED_MESSAGE =
  "The saved credentials of this connection were saved for a different address. Edit the connection and enter them again.";

/** STORAGE_PROVIDER=local: the browser keeps its own connections, so there is nothing to hold here. */
export class UserConnectionStoreUnavailableError extends ResourceError {
  constructor() {
    super(USER_STORE_UNAVAILABLE_MESSAGE, "ACCESS_STORE_UNAVAILABLE", 409);
    this.name = "UserConnectionStoreUnavailableError";
  }
}

const COLLECTION_OF: Record<UserConnectionFamily, StorageCollection> = {
  database: "connections",
  resource: "resource_connections",
};

const RESERVED_PREFIXES = ["seed:", "managed:", "user:"];
const MAX_ID_LENGTH = 128;

export function isUserConnectionFamily(value: unknown): value is UserConnectionFamily {
  return value === "database" || value === "resource";
}

interface Backends {
  provider: ServerStorageProvider;
  store: ForkStore;
}

async function openBackends(): Promise<Backends | null> {
  const provider = await getStorageProvider();
  const store = provider ? await getForkStore() : null;
  return provider && store ? { provider, store } : null;
}

async function requireBackends(): Promise<Backends> {
  const backends = await openBackends();
  if (!backends) throw new UserConnectionStoreUnavailableError();
  return backends;
}

async function readRows(backends: Backends, username: string, family: UserConnectionFamily): Promise<ConnectionRow[]> {
  const rows = await backends.provider.getCollection(username, COLLECTION_OF[family]);
  return Array.isArray(rows) ? (rows as unknown as ConnectionRow[]) : [];
}

async function writeRows(
  backends: Backends,
  username: string,
  family: UserConnectionFamily,
  rows: ConnectionRow[],
): Promise<void> {
  const collection = COLLECTION_OF[family];
  await backends.provider.setCollection(username, collection, rows as unknown as StorageData[typeof collection]);
}

/** A submitted connection this store will keep: an object with an ordinary id and a known type. */
function validRow(family: UserConnectionFamily, input: unknown): ConnectionRow {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ResourceInvalidRequestError("connection: an object is required");
  }
  const row = input as ConnectionRow;
  if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > MAX_ID_LENGTH) {
    throw new ResourceInvalidRequestError("connection.id: a connection id is required");
  }
  if (RESERVED_PREFIXES.some((prefix) => (row.id as string).startsWith(prefix))) {
    throw new ResourceInvalidRequestError("connection.id: this id prefix is reserved");
  }
  const known =
    family === "database"
      ? (SHIPPED_DATABASE_TYPES as readonly unknown[]).includes(row.type)
      : isResourceType(row.type);
  if (!known) throw new ResourceInvalidRequestError(`connection.type: not a ${family} type`);
  return row;
}

function validClear(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((path) => typeof path !== "string")) {
    throw new ResourceInvalidRequestError("clear: a list of secret field paths is expected");
  }
  return input as string[];
}

function omit(secrets: SecretBag, paths: readonly string[]): SecretBag {
  return Object.fromEntries(Object.entries(secrets).filter(([path]) => !paths.includes(path)));
}

/**
 * The stored secrets a submission keeps: all of them, minus the explicitly cleared ones, while the
 * target is unchanged — and none once it changed, so the new address has to be given its
 * credentials on purpose.
 */
function keptSecrets(record: UserSecretRecord | undefined, target: string, clear: readonly string[]): SecretBag {
  return record && record.target === target ? omit(record.secrets, clear) : {};
}

/**
 * Saves a user's connection: the secrets it carries into the write-only store (blank keeps the
 * stored one, `clear` removes one), the rest into the user's synced collection. Answers the row
 * the browser may keep — no secret, and `savedSecrets` saying which the server now holds.
 */
export async function saveUserConnection(
  username: string,
  family: UserConnectionFamily,
  input: unknown,
  clearInput?: unknown,
): Promise<ConnectionRow> {
  const row = validRow(family, input);
  const clear = validClear(clearInput);
  const backends = await requireBackends();
  const id = row.id as string;
  const { stripped, secrets } = extractSecrets(family, row);
  const target = targetFingerprint(family, stripped);
  const records = await loadSecretRecords(backends.store, username, family);
  const next = { ...keptSecrets(records.get(id), target, clear), ...sealSecrets(secrets) };
  const record: UserSecretRecord = { target, secrets: next, updatedAt: new Date().toISOString() };

  if (Object.keys(next).length === 0) await deleteSecretRecord(backends.store, username, family, id);
  else await putSecretRecord(backends.store, username, family, id, record);

  const rows = (await readRows(backends, username, family)).map(
    (candidate) => extractSecrets(family, candidate).stripped,
  );
  const index = rows.findIndex((candidate) => candidate.id === id);
  if (index === -1) rows.push(stripped);
  else rows[index] = stripped;
  await writeRows(backends, username, family, rows);

  return { ...stripped, savedSecrets: heldPaths(family, stripped, record) };
}

/**
 * The connection a "test before save" runs: the submission with the stored secrets it would keep
 * filled in. Never persisted, and never answered to the browser — the caller hands it to a probe.
 */
export async function previewUserConnection(
  username: string,
  family: UserConnectionFamily,
  input: unknown,
  clearInput?: unknown,
): Promise<ConnectionRow> {
  const row = validRow(family, input);
  const clear = validClear(clearInput);
  const backends = await requireBackends();
  const { stripped, secrets } = extractSecrets(family, row);
  const records = await loadSecretRecords(backends.store, username, family);
  const kept = openSecrets(keptSecrets(records.get(row.id as string), targetFingerprint(family, stripped), clear));
  return withSecrets(stripped, { ...kept.secrets, ...secrets });
}

/** Removes a connection's stored secrets. Removing a missing one is not an error. */
export async function forgetUserConnection(username: string, family: UserConnectionFamily, id: unknown): Promise<void> {
  if (typeof id !== "string" || id.length === 0)
    throw new ResourceInvalidRequestError("id: a connection id is required");
  const backends = await requireBackends();
  await deleteSecretRecord(backends.store, username, family, id);
}

/**
 * The one-time move of a browser's connections into the server (idempotent, per user): a row the
 * server does not have yet is added, stripped; a row it has gives up its secrets only while it
 * points where the server's copy points — a browser's stale copy must not re-target a saved one.
 * Answers the user's collection as the browser may keep it, and how many rows gave up secrets.
 */
export async function migrateUserConnections(
  username: string,
  family: UserConnectionFamily,
  input: unknown,
): Promise<{ migrated: number; rows: ConnectionRow[] }> {
  if (!Array.isArray(input)) throw new ResourceInvalidRequestError("connections: a list is expected");
  const backends = await requireBackends();
  const rows = await readRows(backends, username, family);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const accepted: ConnectionRow[] = [];
  let added = false;
  for (const candidate of input) {
    if (typeof candidate !== "object" || candidate === null || typeof (candidate as ConnectionRow).id !== "string") {
      continue;
    }
    const row = candidate as ConnectionRow;
    const server = byId.get(row.id);
    const { stripped } = extractSecrets(family, row);
    if (!server) {
      rows.push(stripped);
      byId.set(row.id, stripped);
      added = true;
      accepted.push(row);
    } else if (targetFingerprint(family, server) === targetFingerprint(family, stripped)) {
      accepted.push(row);
    }
  }
  const { moved } = await absorbSecrets(backends.store, username, family, accepted);
  if (added) await writeRows(backends, username, family, rows);
  auditSecretsMigrated(username, family, moved);
  return { migrated: moved, rows: await readRows(backends, username, family) };
}

/**
 * Resolves `user:<id>` for the signed-in user, secrets included, for a route to run against.
 * Null for any other id, and for an id this user has no connection under — another user's id is
 * indistinguishable from one that does not exist. A connection whose target changed since its
 * secrets were saved is refused rather than run without them.
 */
export async function resolveUserConnection(
  username: string | undefined,
  family: UserConnectionFamily,
  connectionId: unknown,
): Promise<ConnectionRow | null> {
  const id = parseUserConnectionId(connectionId);
  if (id === null || !username) return null;
  const backends = await openBackends();
  if (!backends) return null;
  const row = (await readRows(backends, username, family)).find((candidate) => candidate.id === id);
  if (!row) return null;
  const { stripped } = extractSecrets(family, row);
  const record = (await loadSecretRecords(backends.store, username, family)).get(id);
  if (!record) return stripped;
  if (record.target !== targetFingerprint(family, stripped)) throw new ResourceConflictError(TARGET_CHANGED_MESSAGE);
  const { secrets, undecryptable } = openSecrets(record.secrets);
  if (undecryptable > 0) {
    logger.warn("Stored connection secrets could not be decrypted; the connection runs without them", {
      route: "user-connections",
      count: undecryptable,
    });
  }
  return withSecrets(stripped, secrets);
}
