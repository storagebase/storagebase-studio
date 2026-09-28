import type { ForkStore } from "@/lib/fork-store";
import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";
import { auditSecretsMigrated } from "./audit";
import type { UserConnectionFamily } from "./ids";
import { extractSecrets, targetFingerprint, type ConnectionRow } from "./secrets";
import { loadSecretRecords, putSecretRecord, sealSecrets, type UserSecretRecord } from "./store";

/**
 * Keeps credentials out of the synced connection collections (StorageBase fork).
 *
 * Installed at the storage factory's one choke point, OUTSIDE the credential encryption, so every
 * storage route — GET /api/storage, PUT /api/storage/[collection], POST /api/storage/migrate —
 * reads and writes `connections` and `resource_connections` through it:
 *
 * - a WRITE that carries a secret (an older browser, the upstream first-login migration, an
 *   operator-seeded copy) has it moved into the user's write-only secret store and stripped from
 *   the row before the row is stored;
 * - a READ never returns a secret. A row still holding one from before this layer existed is
 *   migrated on the spot — moved, stripped, rewritten, audited once as a count — and every row
 *   comes back with `savedSecrets`, the paths the server holds for it, which is what makes the
 *   browser address it as `user:<id>`.
 *
 * A write never DELETES a stored secret: a row that disappears from a push may be a stale tab
 * racing a save, and the secret is removed only by the explicit forget call. A row whose target
 * changed reports `savedSecrets: []` and is not given its old secrets (see `targetFingerprint`).
 */

const FAMILY_OF: Partial<Record<StorageCollection, UserConnectionFamily>> = {
  connections: "database",
  resource_connections: "resource",
};

type OpenStore = () => Promise<ForkStore | null>;

async function defaultOpenStore(): Promise<ForkStore | null> {
  // Imported lazily: the fork store reads the storage factory's provider type, and the factory
  // installs this wrapper, so a static import would be a cycle at module load.
  return (await import("@/lib/fork-store")).getForkStore();
}

function isRow(value: unknown): value is ConnectionRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The paths a row may be served as holding: the record's, when it was saved for this target. */
export function heldPaths(
  family: UserConnectionFamily,
  row: ConnectionRow,
  record: UserSecretRecord | undefined,
): string[] {
  if (!record || record.target !== targetFingerprint(family, row)) return [];
  return Object.keys(record.secrets).sort();
}

/**
 * Moves every secret the rows carry into the store and returns the stripped rows, with how many
 * rows had secrets moved. A secret for the same target merges over what is stored; one for a
 * changed target replaces it.
 */
export async function absorbSecrets(
  store: ForkStore,
  username: string,
  family: UserConnectionFamily,
  rows: readonly unknown[],
): Promise<{ rows: unknown[]; moved: number }> {
  let records: Map<string, UserSecretRecord> | undefined;
  let moved = 0;
  const out: unknown[] = [];
  for (const row of rows) {
    if (!isRow(row)) {
      out.push(row);
      continue;
    }
    const { stripped, secrets } = extractSecrets(family, row);
    out.push(stripped);
    // A row with no id cannot be addressed, so its secrets have nowhere to go but away.
    if (Object.keys(secrets).length === 0 || typeof row.id !== "string") continue;
    records ??= await loadSecretRecords(store, username, family);
    const target = targetFingerprint(family, stripped);
    const existing = records.get(row.id);
    const kept = existing && existing.target === target ? existing.secrets : {};
    const record = { target, secrets: { ...kept, ...sealSecrets(secrets) }, updatedAt: new Date().toISOString() };
    await putSecretRecord(store, username, family, row.id, record);
    records.set(row.id, record);
    moved += 1;
  }
  return { rows: out, moved };
}

class ServerHeldSecretsProvider implements ServerStorageProvider {
  constructor(
    private readonly inner: ServerStorageProvider,
    private readonly openStore: OpenStore,
  ) {}

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  isHealthy(): Promise<boolean> {
    return this.inner.isHealthy();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    const data: Record<string, unknown> = { ...(await this.inner.getAllData(userId)) };
    for (const [collection, family] of Object.entries(FAMILY_OF) as [StorageCollection, UserConnectionFamily][]) {
      if (Array.isArray(data[collection])) {
        data[collection] = await this.present(userId, collection, family, data[collection] as unknown[]);
      }
    }
    return data as Partial<StorageData>;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    const value = await this.inner.getCollection(userId, collection);
    const family = FAMILY_OF[collection];
    if (!family || !Array.isArray(value)) return value;
    return (await this.present(userId, collection, family, value)) as StorageData[K];
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    const family = FAMILY_OF[collection];
    if (!family || !Array.isArray(data)) return this.inner.setCollection(userId, collection, data);
    const store = await this.requireStore();
    const { rows } = await absorbSecrets(store, userId, family, data);
    return this.inner.setCollection(userId, collection, rows as StorageData[K]);
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    const next: Record<string, unknown> = { ...data };
    for (const [collection, family] of Object.entries(FAMILY_OF) as [StorageCollection, UserConnectionFamily][]) {
      if (!Array.isArray(next[collection])) continue;
      const store = await this.requireStore();
      const { rows, moved } = await absorbSecrets(store, userId, family, next[collection] as unknown[]);
      next[collection] = rows;
      auditSecretsMigrated(userId, family, moved);
    }
    return this.inner.mergeData(userId, next as Partial<StorageData>);
  }

  /**
   * A server storage provider always has a fork store beside it (both follow STORAGE_PROVIDER), so
   * a missing one is a failure to open it. The write fails rather than falling back to storing the
   * secret in the synced row: the browser keeps its copy and retries.
   */
  private async requireStore(): Promise<ForkStore> {
    const store = await this.openStore();
    if (!store) throw new Error("The connection secret store is not available");
    return store;
  }

  private async present(
    userId: string,
    collection: StorageCollection,
    family: UserConnectionFamily,
    rows: unknown[],
  ): Promise<unknown[]> {
    const store = await this.requireStore();
    let current = rows;
    if (rows.some((row) => isRow(row) && Object.keys(extractSecrets(family, row).secrets).length > 0)) {
      const absorbed = await absorbSecrets(store, userId, family, rows);
      await this.inner.setCollection(userId, collection, absorbed.rows as never);
      auditSecretsMigrated(userId, family, absorbed.moved);
      current = absorbed.rows;
    }
    const records = await loadSecretRecords(store, userId, family);
    return current.map((row) => {
      if (!isRow(row)) return row;
      const { stripped } = extractSecrets(family, row);
      const record = typeof row.id === "string" ? records.get(row.id) : undefined;
      return { ...stripped, savedSecrets: heldPaths(family, stripped, record) };
    });
  }
}

export function withServerHeldSecrets(
  provider: ServerStorageProvider,
  openStore: OpenStore = defaultOpenStore,
): ServerStorageProvider {
  return new ServerHeldSecretsProvider(provider, openStore);
}
