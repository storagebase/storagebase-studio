import { logger } from "@/lib/logger";
import { PostgresStorageProvider } from "@/lib/storage/providers/postgres";
import type { SqlDriver } from "./sql-store";

/**
 * The PostgreSQL driver for the fork store (StorageBase fork): the database STORAGE_PROVIDER=postgres
 * already uses (STORAGE_POSTGRES_URL), through its own small `pg` pool so the fork's tables never
 * contend with the upstream provider's connections.
 *
 * TLS is decided by the upstream provider's own reading of the URL (sslmode, ssl=, local hosts),
 * not a copy of it: the fork store must connect exactly when and how the storage layer does, and
 * a second implementation of that decision would drift. The method is private in TypeScript only,
 * so it is reached through a narrow structural type rather than by editing upstream code.
 */

type PgSslConfig = boolean | { rejectUnauthorized: boolean };

function storageSslConfig(connectionString: string): PgSslConfig {
  const provider = new PostgresStorageProvider(connectionString) as unknown as { buildSSLConfig(): PgSslConfig };
  return provider.buildSSLConfig();
}

/** `?` placeholders, in order, as PostgreSQL's `$1..$n`. The store's SQL carries no `?` in literals. */
export function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export async function openPostgresDriver(
  connectionString = process.env.STORAGE_POSTGRES_URL || "",
): Promise<SqlDriver> {
  if (!connectionString) throw new Error("STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres");
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 30000,
    ssl: storageSslConfig(connectionString),
  });
  // An idle client the server drops emits on the pool; unhandled, that is an uncaught exception
  // (#298, the upstream provider's same guard).
  pool.on("error", (error: unknown) => {
    logger.error("Fork store PostgreSQL pool client error", error, { store: "fork-store" });
  });
  return {
    async run(sql, params = []) {
      await pool.query(toPgPlaceholders(sql), [...params]);
    },
    async all<Row>(sql: string, params: readonly unknown[] = []) {
      const { rows } = await pool.query(toPgPlaceholders(sql), [...params]);
      return rows as Row[];
    },
    async close() {
      await pool.end();
    },
  };
}
