import type { BaseResourceProvider } from "./base-provider";
import { getResourceProviderLoader } from "./registry";
import type { ResourceConnection } from "./types";

/**
 * Provider lifecycle for the resource layer — the parallel of
 * src/lib/db/factory.ts, minus what this surface does not need yet.
 *
 * Differences from the database factory, each deliberate:
 * - No SSH tunnel rewrite here. Resource addressing is endpoint-shaped (a
 *   broker list, an amqp URL, a Vault address), so parsing "which host:port
 *   would a tunnel forward to" is family knowledge; the messaging and vault
 *   modules own that when they land (M3/M4), reusing src/lib/ssh/tunnel.ts by
 *   import. A generic rewrite over a field this layer does not parse would be
 *   a guess wearing a feature's clothes.
 * - The same idle eviction shape as upstream (30 minutes idle, sweep every 5)
 *   because the workload is the same: a browser holds a connection open, then
 *   walks away.
 */

interface CacheEntry {
  provider: BaseResourceProvider;
  connectionId: string;
  connectedAt: number;
  lastUsedAt: number;
}

const IDLE_EVICT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const providerCache = new Map<string, CacheEntry>();

/**
 * The clock the cache reads, injectable for tests — the same seam shape as
 * `VaultDeps` in src/lib/seed/vault-client.ts. Production never calls the
 * setter; the tests use it to move idle time without waiting for it.
 */
let clock: () => number = Date.now;

export function setResourceFactoryClockForTest(next: () => number): void {
  clock = next;
}

/** One-shot creation, no cache: what the meta and test routes use. */
export async function createResourceProvider(connection: ResourceConnection): Promise<BaseResourceProvider> {
  const loader = getResourceProviderLoader(connection.type);
  const loaded = await loader();
  return new loaded.default(connection);
}

export async function getOrCreateResourceProvider(connection: ResourceConnection): Promise<BaseResourceProvider> {
  const entry = providerCache.get(connection.id);
  if (entry && entry.provider.isConnected()) {
    entry.lastUsedAt = clock();
    return entry.provider;
  }
  if (entry) {
    providerCache.delete(connection.id);
    await entry.provider.disconnect().catch(() => undefined);
  }

  const provider = await createResourceProvider(connection);
  await provider.connect();
  const now = clock();
  providerCache.set(connection.id, { provider, connectionId: connection.id, connectedAt: now, lastUsedAt: now });
  scheduleSweep();
  return provider;
}

export async function removeResourceProvider(connectionId: string): Promise<void> {
  const entry = providerCache.get(connectionId);
  if (!entry) return;
  providerCache.delete(connectionId);
  await entry.provider.disconnect().catch(() => undefined);
}

export function clearResourceProviderCache(): void {
  for (const entry of providerCache.values()) {
    entry.provider.disconnect().catch(() => undefined);
  }
  providerCache.clear();
}

export function getResourceProviderCacheStats(): { total: number; connected: number } {
  let connected = 0;
  for (const entry of providerCache.values()) {
    if (entry.provider.isConnected()) connected += 1;
  }
  return { total: providerCache.size, connected };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The sweep body, exported because the interval is not a test surface: the
 * tests drive it directly against a moved clock instead of waiting half an
 * hour. Evicts entries idle past the limit and stops the sweep once the cache
 * empties, so an idle process holds no timer.
 */
export function evictIdleResourceProviders(): void {
  const now = clock();
  for (const [id, entry] of providerCache) {
    if (now - entry.lastUsedAt > IDLE_EVICT_MS) {
      providerCache.delete(id);
      entry.provider.disconnect().catch(() => undefined);
    }
  }
  if (providerCache.size === 0 && sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function scheduleSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(evictIdleResourceProviders, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/**
 * Test a connection without leaving anything cached: connect, read health,
 * disconnect. Mirrors the database test-connection route's one-shot shape so
 * the degraded-success story (connected, but health would not answer) can be
 * reused by the family modules rather than reinvented per family.
 */
export async function testResourceConnection(
  connection: ResourceConnection,
): Promise<{ success: boolean; degraded: boolean; message: string; latencyMs?: number }> {
  const start = Date.now();
  let provider: BaseResourceProvider | null = null;
  try {
    provider = await createResourceProvider(connection);
    await provider.connect();
    const latencyMs = Date.now() - start;
    try {
      const health = await provider.getHealth();
      return {
        success: health.status !== "error",
        degraded: health.status === "degraded",
        message: health.message ?? (health.status === "healthy" ? "Connected" : "Connected with warnings"),
        latencyMs,
      };
    } catch (healthError) {
      return {
        success: true,
        degraded: true,
        message: `Connected, but the health check failed: ${healthError instanceof Error ? healthError.message : String(healthError)}`,
        latencyMs,
      };
    }
  } catch (error) {
    return {
      success: false,
      degraded: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (provider) await provider.disconnect().catch(() => undefined);
  }
}
