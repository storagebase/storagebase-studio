import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { SqlForkStore } from "@/lib/fork-store/sql-store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/lib/fork-store/sqlite-driver";

/**
 * A REAL fork store for the access-model tests (StorageBase fork): the store's SQL on an in-memory
 * SQLite engine through `bun:sqlite`, behind a module mock of `@/lib/fork-store`. `mode` switches
 * what `getForkStore` answers — the working store, no store (STORAGE_PROVIDER=local), or a throw —
 * so every test can reach the three states a caller must handle.
 *
 * Call `installAccessStore()` at the top of a test file, BEFORE importing the module under test.
 */

export interface AccessStoreHandle {
  store: SqlForkStore;
  mode: "store" | "none" | "broken";
  reset(): Promise<void>;
}

export function installAccessStore(): AccessStoreHandle {
  const open = () => {
    const created = new SqlForkStore(sqliteDriver(new Database(":memory:") as unknown as SqliteDatabaseLike), {
      retentionDays: 0,
    });
    return created;
  };
  const handle: AccessStoreHandle = {
    store: open(),
    mode: "store",
    async reset() {
      handle.store = open();
      await handle.store.migrate();
      handle.mode = "store";
    },
  };
  mock.module("@/lib/fork-store", () => ({
    getForkStore: async () => {
      if (handle.mode === "broken") throw new Error("database is locked");
      return handle.mode === "none" ? null : handle.store;
    },
    MAX_AUDIT_PAGE_SIZE: 1000,
    DEFAULT_AUDIT_RETENTION_DAYS: 365,
    readAuditRetentionDays: () => 365,
    closeForkStore: async () => {},
  }));
  return handle;
}
