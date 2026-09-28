import { describe, test, expect, beforeEach, mock } from "bun:test";

/**
 * "Test connection" for a managed connection (StorageBase fork): the stored sealed secrets are
 * opened on the server, the provider is opened once through a one-shot tunnel and closed, and the
 * answer carries the outcome only. The factories are doubled; what they were handed is checked.
 */

const opened: Array<Record<string, unknown>> = [];
let connectError: unknown = null;
const disconnect = mock(async () => {});
mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: async (connection: unknown, run: (effective: unknown) => Promise<unknown>) => run(connection),
  createDatabaseProvider: async (connection: Record<string, unknown>) => {
    opened.push(connection);
    return {
      connect: async () => {
        if (connectError) throw connectError;
      },
      disconnect,
    };
  },
}));
const testResourceConnection = mock(async (connection: Record<string, unknown>) => ({
  success: true,
  degraded: false,
  message: `Connected to ${connection.type}`,
}));
mock.module("@/lib/resources/factory", () => ({ testResourceConnection }));
mock.module("@/lib/resources/providers", () => ({}));

const { testManagedConfig } = await import("@/lib/access/connection-test");
const { encryptSecret } = await import("@/lib/storage/encryption");

beforeEach(() => {
  opened.length = 0;
  connectError = null;
  disconnect.mockClear();
  testResourceConnection.mockClear();
});

describe("testManagedConfig", () => {
  test("a database connection opens with its sealed secrets opened, and is closed", async () => {
    const result = await testManagedConfig("database", "postgres", "Orders", {
      host: "h",
      password: encryptSecret("pw"),
    });
    expect(result).toMatchObject({ success: true, message: "Connected" });
    expect(result.latencyMs).toBeNumber();
    expect(opened[0]).toMatchObject({ id: "admin-test", name: "Orders", type: "postgres", host: "h", password: "pw" });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test("a refused connection answers the server's sentence and is still closed", async () => {
    connectError = new Error("password authentication failed");
    expect(await testManagedConfig("database", "postgres", "Orders", {})).toEqual({
      success: false,
      message: "password authentication failed",
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    connectError = "not an error object";
    expect((await testManagedConfig("database", "postgres", "Orders", {})).message).toBe("not an error object");
  });

  test("a resource connection goes to the resource factory's test with its secrets opened", async () => {
    const result = await testManagedConfig("resource", "s3", "Bucket", { secretAccessKey: encryptSecret("sk") });
    expect(result).toEqual({ success: true, degraded: false, message: "Connected to s3" });
    expect(testResourceConnection.mock.calls[0][0]).toMatchObject({ type: "s3", secretAccessKey: "sk" });
  });
});
