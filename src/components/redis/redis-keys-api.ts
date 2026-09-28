import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";
import type { Container } from "@/lib/db/types";
import type { KeyMeta, RedisKeyTypeFilter, ScanKeysResult } from "@/lib/redis-keys/scan";
import type { DatabaseConnection } from "@/lib/types";

/** The key browser's calls (StorageBase fork). The browser itself never talks to Redis. */

async function post<T>(path: string, connection: DatabaseConnection, fields: object, signal?: AbortSignal): Promise<T> {
  const response = await appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...buildConnectionPayload(connection), ...fields }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The request failed with HTTP ${response.status}`);
  return body;
}

export interface ScanPageRequest {
  readonly database: number;
  readonly cursor: string;
  readonly match?: string;
  readonly type?: RedisKeyTypeFilter;
  readonly limit?: number;
}

export function fetchKeyPage(
  connection: DatabaseConnection,
  request: ScanPageRequest,
  signal?: AbortSignal,
): Promise<ScanKeysResult> {
  return post<ScanKeysResult>("/api/redis/keys", connection, request, signal);
}

export async function fetchKeyMeta(
  connection: DatabaseConnection,
  database: number,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<KeyMeta[]> {
  const body = await post<{ entries: KeyMeta[] }>("/api/redis/keys/meta", connection, { database, keys }, signal);
  return body.entries;
}

/** The numbered databases, through the object tree's own container route. */
export function fetchDatabases(connection: DatabaseConnection, signal?: AbortSignal): Promise<Container[]> {
  return post<Container[]>("/api/db/objects/containers", connection, {}, signal);
}
