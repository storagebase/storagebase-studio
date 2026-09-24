import { getStorageProviderType } from "@/lib/storage/factory";
import { SqlForkStore, type SqlDriver } from "./sql-store";
import type { ForkStore } from "./types";

export type { ForkStore } from "./types";
export { MAX_AUDIT_PAGE_SIZE } from "./types";

/**
 * The fork store for this process (StorageBase fork), backed by whichever server storage
 * STORAGE_PROVIDER configures, or null when it is `local` (browser-only storage has no server
 * database to put a durable trail in; the ring buffer and the stdout line remain).
 *
 * One store per process, held on globalThis for the reason the audit sink registry is: the
 * instrumentation hook and the route handlers can be separately compiled entries. Concurrent
 * first callers share one open+migrate, and a failed open is not memoized, so the next call
 * retries rather than awaiting a rejection forever (the upstream storage factory's rule).
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const MAX_AUDIT_RETENTION_DAYS = 36500;

/** STORAGEBASE_AUDIT_RETENTION_DAYS: a whole number of days, 0 to keep everything; anything else is the default. */
export function readAuditRetentionDays(value = process.env.STORAGEBASE_AUDIT_RETENTION_DAYS): number {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.min(Number.parseInt(value, 10), MAX_AUDIT_RETENTION_DAYS);
}

const STORE_KEY = Symbol.for("storagebase.forkStore");

interface StoreHolder {
  [STORE_KEY]?: Promise<SqlForkStore>;
}

async function openDriver(): Promise<SqlDriver | null> {
  const type = getStorageProviderType();
  if (type === "sqlite") return (await import("./sqlite-driver")).openSqliteDriver();
  if (type === "postgres") return (await import("./postgres-driver")).openPostgresDriver();
  return null;
}

export async function getForkStore(): Promise<ForkStore | null> {
  if (getStorageProviderType() === "local") return null;
  const holder = globalThis as StoreHolder;
  if (!holder[STORE_KEY]) {
    const opening = (async () => {
      const driver = (await openDriver()) as SqlDriver;
      const store = new SqlForkStore(driver, { retentionDays: readAuditRetentionDays() });
      await store.migrate();
      return store;
    })();
    holder[STORE_KEY] = opening;
    opening.catch(() => {
      if (holder[STORE_KEY] === opening) delete holder[STORE_KEY];
    });
  }
  return holder[STORE_KEY];
}

/** Closes and forgets the process's store. For tests and shutdown. */
export async function closeForkStore(): Promise<void> {
  const holder = globalThis as StoreHolder;
  const opening = holder[STORE_KEY];
  delete holder[STORE_KEY];
  if (opening) await (await opening.catch(() => null))?.close();
}
