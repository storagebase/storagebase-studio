import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BaseResourceProvider } from "@/lib/resources/base-provider";
import {
  clearResourceProviderCache,
  createResourceProvider,
  evictIdleResourceProviders,
  getResourceProviderCacheStats,
  getOrCreateResourceProvider,
  removeResourceProvider,
  setResourceFactoryClockForTest,
  testResourceConnection,
} from "@/lib/resources/factory";
import { registerResourceProviderLoader } from "@/lib/resources/registry";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "@/lib/resources/types";

class FakeProvider extends BaseResourceProvider {
  public connects = 0;
  public disconnects = 0;
  public health: ResourceHealth = { status: "healthy" };
  public failConnect = false;
  public failHealth = false;

  /** A test-only forced disconnect through the protected lifecycle hook. */
  simulateDisconnect(): void {
    this.setConnected(false);
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("socket refused");
    this.connects += 1;
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.setConnected(false);
  }

  async getHealth(): Promise<ResourceHealth> {
    if (this.failHealth) throw new Error("health endpoint refused");
    return this.health;
  }

  getCapabilities(): ResourceProviderCapabilities {
    return { category: "blob", defaultPort: 443, supportsSshTunnel: false, operations: ["tree"] };
  }

  getLabels(): ResourceProviderLabels {
    return { containerNoun: "Buckets", itemNoun: "Objects" };
  }

  async listNodes(): Promise<ResourceNodePage> {
    return { nodes: [], truncated: false };
  }
}

const connection = (type: ResourceConnection["type"] = "s3", id = "res-1"): ResourceConnection => ({
  id,
  name: "Test",
  type,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("resource factory", () => {
  let clockMs: number;
  const instances: FakeProvider[] = [];

  beforeEach(() => {
    clearResourceProviderCache();
    clockMs = 1_000_000;
    setResourceFactoryClockForTest(() => clockMs);
    instances.length = 0;
    registerResourceProviderLoader("s3", async () => ({
      default: class extends FakeProvider {
        constructor(config: ResourceConnection) {
          super(config);
          instances.push(this);
        }
      },
    }));
  });

  afterEach(() => {
    setResourceFactoryClockForTest(Date.now);
  });

  test("createResourceProvider builds without connecting and reports its record", async () => {
    const provider = await createResourceProvider(connection());
    expect(provider).toBeInstanceOf(BaseResourceProvider);
    expect(provider.isConnected()).toBe(false);
    expect(provider.describe()).toEqual({ id: "res-1", name: "Test", type: "s3" });
  });

  test("an unregistered type-id refuses with the unavailable vocabulary, not a loader TypeError", async () => {
    await expect(createResourceProvider(connection("kafka"))).rejects.toMatchObject({
      name: "ResourceProviderUnavailableError",
      code: "RESOURCE_PROVIDER_UNAVAILABLE",
      statusCode: 501,
    });
    expect(getResourceProviderCacheStats().total).toBe(0);
  });

  test("getOrCreateResourceProvider connects once and serves the cache", async () => {
    const first = (await getOrCreateResourceProvider(connection())) as unknown as FakeProvider;
    const second = (await getOrCreateResourceProvider(connection("s3", "res-1"))) as unknown as FakeProvider;
    expect(first).toBe(second);
    expect(instances).toHaveLength(1);
    expect(first.connects).toBe(1);
    expect(getResourceProviderCacheStats()).toEqual({ total: 1, connected: 1 });
  });

  test("a disconnected cache entry is rebuilt, not reused", async () => {
    const first = (await getOrCreateResourceProvider(connection())) as unknown as FakeProvider;
    first.simulateDisconnect();
    const second = (await getOrCreateResourceProvider(connection())) as unknown as FakeProvider;
    expect(second).not.toBe(first);
    expect(first.disconnects).toBe(1);
  });

  test("removeResourceProvider disconnects and clears the entry; a second call is a no-op", async () => {
    const provider = (await getOrCreateResourceProvider(connection())) as unknown as FakeProvider;
    await removeResourceProvider("res-1");
    expect(provider.disconnects).toBe(1);
    expect(getResourceProviderCacheStats().total).toBe(0);
    await removeResourceProvider("res-1");
  });

  test("clearResourceProviderCache disconnects every entry", async () => {
    await getOrCreateResourceProvider(connection("s3", "res-1"));
    await getOrCreateResourceProvider(connection("s3", "res-2"));
    clearResourceProviderCache();
    expect(instances.map((p) => p.disconnects)).toEqual([1, 1]);
  });

  test("idle entries are evicted past the 30-minute limit and the sweep stops on an empty cache", async () => {
    await getOrCreateResourceProvider(connection());
    clockMs += 31 * 60 * 1000;
    // Still-connected is not enough: idle is idle.
    evictIdleResourceProviders();
    expect(getResourceProviderCacheStats().total).toBe(0);
    expect(instances[0].disconnects).toBe(1);
    evictIdleResourceProviders();
  });

  test("a recent use survives the sweep", async () => {
    await getOrCreateResourceProvider(connection());
    clockMs += 10 * 60 * 1000;
    evictIdleResourceProviders();
    expect(getResourceProviderCacheStats().total).toBe(1);
  });
});

describe("testResourceConnection", () => {
  beforeEach(() => {
    clearResourceProviderCache();
    registerResourceProviderLoader("s3", async () => ({ default: FakeProvider }));
  });

  test("a healthy connect answers success with latency", async () => {
    const result = await testResourceConnection(connection());
    expect(result).toMatchObject({ success: true, degraded: false });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a connect whose health fails is degraded success, never failure", async () => {
    const failing = class extends FakeProvider {
      async connect(): Promise<void> {
        this.failHealth = true;
        await super.connect();
      }
    };
    registerResourceProviderLoader("s3", async () => ({ default: failing }));
    const result = await testResourceConnection(connection());
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.message).toContain("health check failed");
  });

  test("a refused connect answers failure with the provider's sentence", async () => {
    const failing = class extends FakeProvider {
      constructor(config: ResourceConnection) {
        super(config);
        this.failConnect = true;
      }
    };
    registerResourceProviderLoader("s3", async () => ({ default: failing }));
    const result = await testResourceConnection(connection());
    expect(result).toMatchObject({ success: false, degraded: false, message: "socket refused" });
  });
});
