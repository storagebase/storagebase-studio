import { describe, expect, test } from "bun:test";
import {
  commandText,
  DEFAULT_KEY_LIMIT,
  MAX_KEY_LIMIT,
  MAX_META_KEYS,
  MAX_PATTERN_LENGTH,
  parseScanReply,
  readKeyMeta,
  readMetaRequest,
  readScanRequest,
  RedisKeysRequestError,
  SCAN_COUNT,
  scanKeys,
  sessionDatabase,
  type RedisCommandRunner,
} from "@/lib/redis-keys/scan";
import type { QueryResult } from "@/lib/types";

/** A SCAN reply the way RedisProvider.formatResult shapes it (redis.md §5.2). */
function scanReply(cursor: string, keys: string[]): QueryResult {
  return {
    rows: [
      { index: 1, value: cursor },
      { index: 2, value: JSON.stringify(keys) },
    ],
    fields: ["index", "value"],
    rowCount: 2,
    executionTime: 0,
  };
}

function status(text: string): QueryResult {
  return { rows: [{ result: text }], fields: ["result"], rowCount: 1, executionTime: 0 };
}

/** A runner answering SCAN from a list of pages, recording every command it was sent. */
function pagedRunner(pages: Array<[string, string[]]>) {
  const sent: Array<{ command: string; args: string[] }> = [];
  let page = 0;
  const runner: RedisCommandRunner = {
    async query(sql) {
      const parsed = JSON.parse(sql) as { command: string; args: string[] };
      sent.push(parsed);
      const [cursor, keys] = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return scanReply(cursor, keys);
    },
  };
  return { runner, sent };
}

describe("scanKeys", () => {
  test("walks the cursor to 0 with COUNT, never KEYS, and dedupes repeated keys", async () => {
    const { runner, sent } = pagedRunner([
      ["17", ["a", "b"]],
      ["0", ["b", "c"]],
    ]);
    const result = await scanKeys(runner, { cursor: "0", limit: 100, deadlineMs: 5000 });
    expect(result).toEqual({
      keys: ["a", "b", "c"],
      cursor: "0",
      truncated: false,
      scanned: 4,
      iterations: 2,
      stoppedBy: "complete",
    });
    expect(sent).toEqual([
      { command: "SCAN", args: ["0", "COUNT", String(SCAN_COUNT)] },
      { command: "SCAN", args: ["17", "COUNT", String(SCAN_COUNT)] },
    ]);
    expect(sent.some((call) => call.command === "KEYS")).toBe(false);
  });

  test("passes MATCH and TYPE through and resumes from the given cursor", async () => {
    const { runner, sent } = pagedRunner([["0", ["user:1"]]]);
    await scanKeys(runner, { cursor: "99", match: "user:*", type: "hash", limit: 10, deadlineMs: 5000 });
    expect(sent[0]).toEqual({ command: "SCAN", args: ["99", "MATCH", "user:*", "COUNT", "500", "TYPE", "hash"] });
  });

  test("stops at the key cap and hands back the cursor to resume from", async () => {
    const { runner } = pagedRunner([
      ["5", ["a", "b"]],
      ["9", ["c", "d"]],
      ["0", ["e"]],
    ]);
    const result = await scanKeys(runner, { cursor: "0", limit: 3, deadlineMs: 5000 });
    // The whole second batch is kept: its cursor has already moved past those keys.
    expect(result.keys).toEqual(["a", "b", "c", "d"]);
    expect(result).toMatchObject({ cursor: "9", truncated: true, stoppedBy: "limit", iterations: 2 });
  });

  test("stops at the deadline after at least one iteration", async () => {
    const { runner } = pagedRunner([["5", ["a"]]]);
    let clock = 0;
    const result = await scanKeys(runner, {
      cursor: "0",
      limit: 100,
      deadlineMs: 10,
      now: () => {
        const at = clock;
        clock += 20;
        return at;
      },
    });
    expect(result).toMatchObject({ keys: ["a"], cursor: "5", truncated: true, stoppedBy: "deadline", iterations: 1 });
  });

  test("an empty page with a live cursor keeps walking", async () => {
    const { runner } = pagedRunner([
      ["3", []],
      ["0", ["z"]],
    ]);
    const result = await scanKeys(runner, { cursor: "0", limit: 100, deadlineMs: 5000 });
    expect(result.keys).toEqual(["z"]);
  });
});

describe("parseScanReply", () => {
  test("reads the cursor and the JSON-encoded key list", () => {
    expect(parseScanReply(scanReply("12", ["x"]))).toEqual({ cursor: "12", keys: ["x"] });
  });

  test("refuses a reply of any other shape", () => {
    expect(() => parseScanReply(status("OK"))).toThrow("unexpected reply");
    const notAnArray = { ...scanReply("0", []), rows: [{ value: "0" }, { value: '{"a":1}' }] };
    expect(() => parseScanReply(notAnArray)).toThrow("unexpected reply");
  });
});

describe("readKeyMeta", () => {
  test("reads TYPE, TTL and MEMORY USAGE, degrading refused fields to null", async () => {
    const sent: string[] = [];
    const runner: RedisCommandRunner = {
      async query(sql) {
        sent.push(sql);
        const { command, args } = JSON.parse(sql) as { command: string; args: string[] };
        const key = args.at(-1);
        if (command === "TYPE") return status(key === "gone" ? "none" : "hash");
        if (command === "TTL") {
          if (key === "gone") return status("(integer) -2");
          return status("(integer) 60");
        }
        if (key === "gone") return status("(nil)");
        if (key === "refused") throw new Error("NOPERM");
        return status("(integer) 128");
      },
    };
    const entries = await readKeyMeta(runner, ["user:1", "gone", "refused"]);
    expect(entries).toEqual([
      { key: "user:1", type: "hash", ttl: 60, memory: 128 },
      { key: "gone", type: "none", ttl: -2, memory: null },
      { key: "refused", type: "hash", ttl: 60, memory: null },
    ]);
    expect(sent).toContain(commandText("MEMORY", ["USAGE", "user:1"]));
  });

  test("a TYPE reply that is not a status reads as none; an odd TTL reads as null", async () => {
    const runner: RedisCommandRunner = {
      async query(sql) {
        const { command } = JSON.parse(sql) as { command: string };
        if (command === "TYPE") return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
        return status("weird");
      },
    };
    expect(await readKeyMeta(runner, ["k"])).toEqual([{ key: "k", type: "none", ttl: null, memory: null }]);
  });
});

describe("readScanRequest", () => {
  test("defaults: the session database, cursor 0, every key, the default cap", () => {
    expect(readScanRequest({}, 2)).toEqual({ database: 2, cursor: "0", limit: DEFAULT_KEY_LIMIT });
  });

  test("accepts a database as a number or a decimal string, and clamps the limit", () => {
    expect(readScanRequest({ database: "3", limit: 10 ** 9 }, 0)).toMatchObject({ database: 3, limit: MAX_KEY_LIMIT });
    expect(readScanRequest({ database: 5, cursor: "42", match: "a*", type: "zset" }, 0)).toEqual({
      database: 5,
      cursor: "42",
      match: "a*",
      type: "zset",
      limit: DEFAULT_KEY_LIMIT,
    });
  });

  test("an empty or * pattern means no MATCH", () => {
    expect(readScanRequest({ match: "*" }, 0).match).toBeUndefined();
    expect(readScanRequest({ match: "" }, 0).match).toBeUndefined();
  });

  test.each([
    [{ database: -1 }, "database"],
    [{ database: "x" }, "database"],
    [{ database: 1.5 }, "database"],
    [{ cursor: 5 }, "cursor"],
    [{ cursor: "1; FLUSHALL" }, "cursor"],
    [{ match: 3 }, "match"],
    [{ match: "a".repeat(MAX_PATTERN_LENGTH + 1) }, "match"],
    [{ type: "module" }, "type"],
    [{ limit: 0 }, "limit"],
    [{ limit: "10" }, "limit"],
  ])("refuses %j", (body, field) => {
    expect(() => readScanRequest(body as Record<string, unknown>, 0)).toThrow(RedisKeysRequestError);
    expect(() => readScanRequest(body as Record<string, unknown>, 0)).toThrow(field);
  });
});

describe("readMetaRequest", () => {
  test("dedupes the key names and defaults the database", () => {
    expect(readMetaRequest({ keys: ["a", "a", "b"] }, 1)).toEqual({ database: 1, keys: ["a", "b"] });
  });

  test("refuses more than the bound, a non-array and non-string names", () => {
    for (const keys of [Array.from({ length: MAX_META_KEYS + 1 }, (_, i) => `k${i}`), "a", [1]]) {
      expect(() => readMetaRequest({ keys }, 0)).toThrow(RedisKeysRequestError);
    }
  });
});

describe("sessionDatabase", () => {
  test("reads the connection's database the way the provider does, defaulting to 0", () => {
    expect(sessionDatabase(undefined)).toBe(0);
    expect(sessionDatabase("")).toBe(0);
    expect(sessionDatabase("4")).toBe(4);
    expect(sessionDatabase("nope")).toBe(0);
  });
});
