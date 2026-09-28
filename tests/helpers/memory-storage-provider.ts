import type { ServerStorageProvider, StorageCollection, StorageData } from "@/lib/storage/types";

/**
 * A `ServerStorageProvider` held in memory, for tests of the layers above the SQL providers: what
 * `rows` holds is exactly what a real provider would have written to its `data` column, so a test
 * can assert what reached storage as well as what a read answers.
 */
export interface MemoryStorageProvider extends ServerStorageProvider {
  rows: Map<string, unknown>;
}

export function memoryStorageProvider(): MemoryStorageProvider {
  const rows = new Map<string, unknown>();
  const key = (userId: string, collection: string) => `${userId}\u0000${collection}`;
  const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    rows,
    async initialize() {},
    async isHealthy() {
      return true;
    },
    async close() {},
    async getAllData(userId) {
      const out: Record<string, unknown> = {};
      for (const [k, value] of rows) {
        const [owner, collection] = k.split("\u0000");
        if (owner === userId) out[collection] = copy(value);
      }
      return out as Partial<StorageData>;
    },
    async getCollection<K extends StorageCollection>(userId: string, collection: K) {
      const value = rows.get(key(userId, collection));
      return value === undefined ? null : (copy(value) as StorageData[K]);
    },
    async setCollection(userId, collection, data) {
      rows.set(key(userId, collection), copy(data));
    },
    async mergeData(userId, data) {
      for (const [collection, value] of Object.entries(data)) {
        if (value !== undefined) rows.set(key(userId, collection), copy(value));
      }
    },
  };
}
