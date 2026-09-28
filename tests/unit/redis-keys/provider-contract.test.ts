/**
 * The key browser reads replies back out of RedisProvider's grid shaping (redis.md §5.2). This
 * file runs the scan and metadata reads against the REAL provider over a mocked ioredis, so a
 * change to that shaping fails here rather than in a browser.
 */
import { describe, expect, mock, test } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";

const calls: Array<{ command: string; args: unknown[] }> = [];

mock.module("ioredis", () => {
  class MockRedis {
    on() {
      return this;
    }
    async connect() {}
    async quit() {}
    disconnect() {}
    async call(command: string, ...args: unknown[]) {
      calls.push({ command, args });
      if (command === "SCAN") return args[0] === "0" ? ["7", ["user:1", "user:2"]] : ["0", []];
      if (command === "TYPE") return "hash";
      if (command === "TTL") return -1;
      if (command === "MEMORY") return null;
      throw new Error(`unexpected ${command}`);
    }
  }
  return { default: MockRedis, Redis: MockRedis };
});

const { RedisProvider } = await import("@/lib/db/providers/keyvalue/redis");
const { readKeyMeta, scanKeys } = await import("@/lib/redis-keys/scan");

const connection: DatabaseConnection = {
  id: "r1",
  name: "cache",
  type: "redis",
  host: "localhost",
  port: 6379,
  createdAt: new Date(),
};

describe("the key browser over the real RedisProvider", () => {
  test("SCAN pages and TYPE/TTL/MEMORY USAGE parse from the provider's own reply shapes", async () => {
    const provider = new RedisProvider(connection);
    await provider.connect();

    const result = await scanKeys(provider, { cursor: "0", limit: 100, deadlineMs: 5000 });
    expect(result).toMatchObject({ keys: ["user:1", "user:2"], cursor: "0", truncated: false, iterations: 2 });
    expect(calls[0]).toEqual({ command: "SCAN", args: ["0", "COUNT", "500"] });

    expect(await readKeyMeta(provider, ["user:1"])).toEqual([{ key: "user:1", type: "hash", ttl: -1, memory: null }]);
    await provider.disconnect();
  });
});
