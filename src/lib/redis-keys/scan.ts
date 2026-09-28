import type { QueryResult } from "@/lib/types";

/**
 * The Redis key browser's server-side reads (StorageBase fork; see docs/providers/redis.md
 * "Key browser").
 *
 * Everything here goes through the provider's own command path, `query()`, in the lossless JSON
 * command form (`{"command":"SCAN","args":[...]}`, redis.md §3.4). Nothing reaches ioredis
 * directly, so a connection's TLS, ACL user and Sentinel settings are the provider's, and nothing
 * under `src/lib/db/` had to change for this feature.
 *
 * The replies are read back out of the provider's grid shaping (redis.md §5.2): an array reply is
 * `{ index, value }` rows with a nested array JSON-encoded in `value`, an integer is
 * `(integer) N`, a nil is `(nil)` and a status is its own text.
 */

/** What this module needs of a provider: its command path and nothing else. */
export interface RedisCommandRunner {
  query(sql: string): Promise<QueryResult>;
}

/** Keys one request returns when the caller names no cap. */
export const DEFAULT_KEY_LIMIT = 10_000;
/** The most keys one request may ask for. */
export const MAX_KEY_LIMIT = 50_000;
/** The COUNT hint per SCAN iteration: large enough to walk quickly, small enough never to block. */
export const SCAN_COUNT = 500;
/** Wall-clock budget for one request's walk. */
export const SCAN_DEADLINE_MS = 5_000;
/** The most keys one metadata request may name. */
export const MAX_META_KEYS = 100;
/** The longest MATCH pattern accepted. */
export const MAX_PATTERN_LENGTH = 1_024;

/** The value types SCAN's TYPE filter is offered for. */
export const REDIS_KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream"] as const;
export type RedisKeyTypeFilter = (typeof REDIS_KEY_TYPES)[number];

export interface ScanKeysOptions {
  /** Where to resume; "0" starts a new walk. */
  readonly cursor: string;
  /** A Redis glob; absent lists every key. */
  readonly match?: string;
  readonly type?: RedisKeyTypeFilter;
  readonly limit: number;
  readonly deadlineMs: number;
  /** Injected clock, for the deadline. */
  readonly now?: () => number;
}

export interface ScanKeysResult {
  /** Distinct key names, in the order SCAN returned them. */
  readonly keys: string[];
  /** Where the next request resumes; "0" when the walk is complete. */
  readonly cursor: string;
  /** Whether keys remain beyond `cursor`. */
  readonly truncated: boolean;
  /** Key names SCAN returned, duplicates included (SCAN may repeat a key across iterations). */
  readonly scanned: number;
  readonly iterations: number;
  /** Why the walk stopped. */
  readonly stoppedBy: "complete" | "limit" | "deadline";
}

export class RedisKeysRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisKeysRequestError";
  }
}

export function commandText(command: string, args: readonly string[]): string {
  return JSON.stringify({ command, args });
}

function rowValue(result: QueryResult, index: number): unknown {
  return result.rows[index]?.value;
}

/** A SCAN reply as the provider shapes it: row 1 the next cursor, row 2 the keys as JSON. */
export function parseScanReply(result: QueryResult): { cursor: string; keys: string[] } {
  const cursor = rowValue(result, 0);
  const encoded = rowValue(result, 1);
  if (typeof cursor !== "string" || typeof encoded !== "string") {
    throw new Error("Redis answered SCAN with an unexpected reply");
  }
  const keys: unknown = JSON.parse(encoded);
  if (!Array.isArray(keys)) throw new Error("Redis answered SCAN with an unexpected reply");
  return { cursor, keys: keys.map(String) };
}

/**
 * One bounded, non-blocking walk: SCAN with COUNT, never KEYS. It stops at the first of the
 * cursor returning to "0", `limit` keys collected, or the deadline. The last iteration's keys are
 * all kept, so a response may exceed `limit` by up to one batch: dropping them would lose keys
 * the returned cursor has already moved past.
 */
export async function scanKeys(runner: RedisCommandRunner, options: ScanKeysOptions): Promise<ScanKeysResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.deadlineMs;
  const seen = new Set<string>();
  const filters = [
    ...(options.match !== undefined ? ["MATCH", options.match] : []),
    "COUNT",
    String(SCAN_COUNT),
    ...(options.type !== undefined ? ["TYPE", options.type] : []),
  ];

  let cursor = options.cursor;
  let scanned = 0;
  let iterations = 0;
  let stoppedBy: ScanKeysResult["stoppedBy"] = "complete";

  // A `while (true)` with the three breaks above, matching the reader loops
  // elsewhere in the app (QuerySafetyDialog, streaming reads): the walk ends
  // at the cursor returning to "0", the key cap, or the deadline.
  while (true) {
    const reply = parseScanReply(await runner.query(commandText("SCAN", [cursor, ...filters])));
    iterations += 1;
    cursor = reply.cursor;
    scanned += reply.keys.length;
    for (const key of reply.keys) seen.add(key);

    if (cursor === "0") break;
    if (seen.size >= options.limit) {
      stoppedBy = "limit";
      break;
    }
    if (now() >= deadline) {
      stoppedBy = "deadline";
      break;
    }
  }

  return { keys: [...seen], cursor, truncated: cursor !== "0", scanned, iterations, stoppedBy };
}

export interface KeyMeta {
  readonly key: string;
  /** TYPE's answer; "none" when the key no longer exists. */
  readonly type: string;
  /** Seconds to live: -1 no expiry, -2 no such key; null when the server refused TTL. */
  readonly ttl: number | null;
  /** MEMORY USAGE in bytes; null when the server refused it or does not implement it. */
  readonly memory: number | null;
}

function integerOf(result: QueryResult): number | null {
  const text = result.rows[0]?.result;
  if (typeof text !== "string") return null;
  const match = /^\(integer\) (-?\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

function statusOf(result: QueryResult): string | null {
  const text = result.rows[0]?.result;
  return typeof text === "string" ? text : null;
}

/** A refused command answers null for that one field rather than failing the batch. */
async function optional<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * TYPE, TTL and MEMORY USAGE for a handful of keys. Issued together rather than one after
 * another: the provider holds one ioredis connection, which writes concurrent commands without
 * waiting for each reply, so the batch costs one round trip's latency rather than 3 x N. TYPE is
 * required; TTL and MEMORY USAGE degrade to null per key (an ACL may refuse MEMORY, and some
 * Redis-compatible servers do not implement it).
 */
export async function readKeyMeta(runner: RedisCommandRunner, keys: readonly string[]): Promise<KeyMeta[]> {
  return Promise.all(
    keys.map(async (key) => {
      const [type, ttl, memory] = await Promise.all([
        runner.query(commandText("TYPE", [key])).then(statusOf),
        optional(async () => integerOf(await runner.query(commandText("TTL", [key])))),
        optional(async () => integerOf(await runner.query(commandText("MEMORY", ["USAGE", key])))),
      ]);
      return { key, type: type ?? "none", ttl, memory };
    }),
  );
}

// ─── Request parsing ────────────────────────────────────────────────────────

function readDatabase(body: Record<string, unknown>, fallback: number): number {
  const value = body.database;
  if (value === undefined) return fallback;
  const database = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof database !== "number" || !Number.isSafeInteger(database) || database < 0) {
    throw new RedisKeysRequestError("database must be a non-negative integer");
  }
  return database;
}

/** The database the connection's session is in; absent means 0, as the provider reads it. */
export function sessionDatabase(connectionDatabase: string | undefined): number {
  const parsed = connectionDatabase ? Number.parseInt(connectionDatabase, 10) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export interface ScanRequest {
  readonly database: number;
  readonly cursor: string;
  readonly match?: string;
  readonly type?: RedisKeyTypeFilter;
  readonly limit: number;
}

export function readScanRequest(body: Record<string, unknown>, defaultDatabase: number): ScanRequest {
  const database = readDatabase(body, defaultDatabase);

  const cursor = body.cursor ?? "0";
  if (typeof cursor !== "string" || !/^\d{1,32}$/.test(cursor)) {
    throw new RedisKeysRequestError("cursor must be the decimal cursor a previous response returned");
  }

  const rawMatch = body.match;
  if (rawMatch !== undefined && (typeof rawMatch !== "string" || rawMatch.length > MAX_PATTERN_LENGTH)) {
    throw new RedisKeysRequestError(`match must be a glob of at most ${MAX_PATTERN_LENGTH} characters`);
  }
  // "*" and "" both mean every key; sending no MATCH is the cheaper spelling of it.
  const match = rawMatch === undefined || rawMatch === "" || rawMatch === "*" ? undefined : rawMatch;

  const type = body.type;
  if (type !== undefined && !(REDIS_KEY_TYPES as readonly unknown[]).includes(type)) {
    throw new RedisKeysRequestError(`type must be one of ${REDIS_KEY_TYPES.join(", ")}`);
  }

  const limit = body.limit ?? DEFAULT_KEY_LIMIT;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RedisKeysRequestError("limit must be a positive integer");
  }

  return {
    database,
    cursor,
    ...(match !== undefined ? { match } : {}),
    ...(type !== undefined ? { type: type as RedisKeyTypeFilter } : {}),
    limit: Math.min(limit, MAX_KEY_LIMIT),
  };
}

export interface MetaRequest {
  readonly database: number;
  readonly keys: string[];
}

export function readMetaRequest(body: Record<string, unknown>, defaultDatabase: number): MetaRequest {
  const database = readDatabase(body, defaultDatabase);
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length > MAX_META_KEYS || !keys.every((key) => typeof key === "string")) {
    throw new RedisKeysRequestError(`keys must be an array of at most ${MAX_META_KEYS} key names`);
  }
  return { database, keys: [...new Set(keys as string[])] };
}
