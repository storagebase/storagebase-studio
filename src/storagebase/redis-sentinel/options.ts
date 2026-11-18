/**
 * The fork side of seam S4: Redis Sentinel options, parsed out of a connection string the
 * upstream redis provider does not read.
 *
 * Upstream's `RedisProvider` builds its ioredis options from `host`, `port`, `user`,
 * `password`, `database` and `ssl` alone (`redisOptions()`); it never opens `connectionString`.
 * The S4 seam adds exactly two lines to that provider — an import and one spread inside the
 * `new Redis({...})` options — and everything Sentinel lives here instead. The contract the
 * seam depends on is `storagebaseSentinelOptions()`'s: `{}` for every connection that does not
 * carry a `redis-sentinel://` / `rediss-sentinel://` string, so upstream behaviour is
 * bit-identical unless the string opts in.
 *
 * **The interim's reach (drift note, REFORK_ANALYSIS.md 5.5).** At this ref a SEED cannot carry
 * the string: the seed schema refuses `connectionString` on a `redis` connection
 * (src/lib/seed/types.ts, `CONNECTION_STRING_ACCEPTED.redis` is false), and the form's paste
 * row claims only `redis://` and `rediss://` (redis-connection-string.ts). The string reaches
 * the provider only through a connection an API caller supplies inline, which
 * `resolveConnection` returns verbatim. Real seed/form support lands with the upstream PR; the
 * seam is deleted the day it merges.
 *
 * Grammar, pinned by tests/storagebase/unit/redis-sentinel/options.test.ts and documented for
 * users in docs/storagebase/redis-sentinel.md:
 *
 * ```text
 * redis-sentinel://[:password@]host1[:port][,host2[:port][,…]][/<db>][?name=<master>[&sentinelPassword=<pw>]]
 * rediss-sentinel://…  — the same, with TLS to the sentinels and to the master
 * ```
 *
 * Anything malformed answers `null`, never a throw: a half-remembered string degrades to the
 * standalone connection the fields describe, which fails in upstream's own words, rather than
 * to a half-built sentinel client that connects somewhere the operator never said.
 */

import type { RedisOptions } from "ioredis";
import type { DatabaseConnection } from "@/lib/types";

/** Sentinel's own default port, which a node listed without one takes. */
const DEFAULT_SENTINEL_PORT = 26379;

/** How many times the whole sentinel list is retried before a connect gives up. */
const SENTINEL_RETRY_ATTEMPTS = 3;

/** The two schemes this module answers, in either letter case (RFC 3986: schemes are case-insensitive). */
const SENTINEL_SCHEME = /^(rediss|redis)-sentinel:\/\//i;

/** The secure spelling alone, read after the scheme match so a TLS variant cannot pass unnoticed. */
const SECURE_SENTINEL_SCHEME = /^rediss-sentinel:\/\//i;

/** The query parameters the grammar carries, keyed as they are looked up: lower-cased names. */
const KNOWN_QUERY_PARAMS = new Set(["name", "sentinelpassword"]);

/**
 * The TLS the secure spelling means, one object shared by the master hop (`tls` +
 * `enableTLSForSentinelMode`) and the sentinel hop (`sentinelTLS`), the way the old fork's
 * one-setting-covers-both-hops rule worked. `rejectUnauthorized: false` is upstream's own
 * mapping of a secure SCHEME (redis-connection-string.ts maps a pasted `rediss://` to sslMode
 * `require`, and `buildTLSOptions` maps `require` to exactly this): a self-hosted sentinel
 * deployment presents a self-signed certificate by default, so a chain-checking object here
 * would refuse the ordinary install. The connection's SSL panel stays the one place
 * verification is configured — and with the string carrying no certificate material, the
 * panel cannot be honoured from here at all.
 */
const SENTINEL_TLS: NonNullable<RedisOptions["tls"]> = { rejectUnauthorized: false };

/**
 * One parsed `redis-sentinel://` string: everything the options builder needs, nothing it has
 * to guess. The passwords travel decoded but otherwise as written — the builder, not the
 * parser, owns the one-secret defaulting rule.
 */
export interface SentinelConnection {
  /** The master group the sentinels monitor, ioredis's `name`. Required: ioredis's SentinelConnector throws without it. */
  readonly masterName: string;
  /** The sentinel nodes, a port defaulting to 26379. Empty never reaches this type: parsing answers null first. */
  readonly sentinels: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** The numbered database the path named, when the string carried one. Unnamed stays the connection's own `database` field's business. */
  readonly database?: number;
  /** The Redis AUTH password from `:password@`, when the string carried one. */
  readonly password?: string;
  /** The sentinels' own password from `sentinelPassword=`, when the string carried one. */
  readonly sentinelPassword?: string;
  /** True for the `rediss-sentinel://` spelling: TLS to the sentinels and to the master. */
  readonly tls: boolean;
}

/**
 * Bounded, unlike ioredis's default, which retries forever: `connect()` awaits the master's
 * address, so with every sentinel unreachable an unbounded strategy never settles and the
 * connection test hangs with no sentence at all. A bounded one rejects with ioredis's own
 * "All sentinels are unreachable" and the last error it saw.
 *
 * Ported from the old fork (legacy/0.16-main, keyvalue/redis.ts) unchanged: the whole list
 * three times — 200, 400 and 600 ms apart, the cap a guard against a future bump of
 * SENTINEL_RETRY_ATTEMPTS rather than a reachable arm today — then give up for good, which
 * ends the client and lets the provider cache open a fresh one.
 */
function sentinelRetryStrategy(attempt: number): number | null {
  return attempt > SENTINEL_RETRY_ATTEMPTS ? null : Math.min(attempt * 200, 1000);
}

/**
 * Percent-decode a component, keeping it verbatim when it is not a valid escape sequence —
 * a sentinel password may legally contain a literal `%`. The same rule upstream's paste
 * parser applies (connection-string/shared.ts `safeDecodeURIComponent`), inlined here so this
 * module imports nothing it does not need to execute under the coverage gate.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The host list as ioredis takes it: comma-separated `host[:port]` entries, blanks dropped, a
 * bracketed `[::1]:26379` read as an IPv6 host, a node without a port taking Sentinel's own
 * 26379. A port that is not a TCP port is refused — a typo there is a sentinel nobody runs —
 * and so is an unbracketed IPv6 address, which the entry grammar cannot tell from a broken
 * `host:port`.
 *
 * Ported from the old fork's `parseSentinelNodes`, throwing turned into `null`: here a bad
 * entry is a refusal of the whole string, and the caller degrades to standalone rather than
 * raising out of a provider's constructor.
 */
function parseSentinelNodes(list: string): Array<{ host: string; port: number }> | null {
  const nodes: Array<{ host: string; port: number }> = [];
  for (const raw of list.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(.*))?$/.exec(entry);
    const host = match?.[1] ?? match?.[2];
    const portText = match?.[3];
    const port = portText === undefined ? DEFAULT_SENTINEL_PORT : Number(portText);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    nodes.push({ host, port });
  }
  return nodes.length > 0 ? nodes : null;
}

/**
 * Parses a `redis-sentinel://` (or `rediss-sentinel://`) connection string into its parts, or
 * null when the string is not one or does not hold together.
 *
 * Strict by design, and the strictness is the safety: a query parameter this grammar does not
 * know, a fragment, a `user:password@` userinfo (the string carries no ACL user — the
 * connection's `user` field names it, as upstream reads it), a second unescaped `@`, a path
 * that is not a database number — each refuses the whole string rather than being half-read
 * into a client that connects somewhere the operator did not fully say. A password that
 * contains `@` or `&` or `%` travels percent-encoded, the way every URL component does.
 *
 * Never throws: the refusals are returns, and the one input that could raise (a non-string
 * `connectionString` reaching a JS caller's inline connection) is `storagebaseSentinelOptions`'s
 * to catch.
 */
export function parseSentinelConnectionString(connectionString: string): SentinelConnection | null {
  const text = connectionString.trim();
  if (!SENTINEL_SCHEME.test(text)) return null;
  // A fragment is nothing a connection can honour, and its presence means a browser URL was
  // pasted rather than a connection string. Refused rather than stripped: a stripped one
  // would parse and quietly drop whatever the fragment named.
  if (text.includes("#")) return null;

  const afterScheme = text.slice(text.indexOf("://") + 3);

  // The query, read before the host list so a bad parameter refuses the whole string rather
  // than leaving nodes parsed out of a URL that never held together.
  const queryAt = afterScheme.indexOf("?");
  const beforeQuery = queryAt === -1 ? afterScheme : afterScheme.slice(0, queryAt);
  const params = new Map<string, string>();
  if (queryAt !== -1) {
    const query = afterScheme.slice(queryAt + 1);
    if (query === "") return null;
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq === -1) return null;
      const name = part.slice(0, eq).toLowerCase();
      if (!KNOWN_QUERY_PARAMS.has(name)) return null;
      params.set(name, safeDecode(part.slice(eq + 1)));
    }
  }
  // The master group is the one part with no default: ioredis's SentinelConnector throws
  // "Requires the name of master." without it (SentinelConnector/index.js), so a string that
  // stays silent about the group is refused here instead of exploding at connect.
  const masterName = params.get("name")?.trim();
  if (masterName === undefined || masterName === "") return null;

  // The path is a database number or nothing: `/abc` is a refusal, not a name.
  const pathAt = beforeQuery.indexOf("/");
  const path = pathAt === -1 ? "" : beforeQuery.slice(pathAt);
  if (path !== "" && !/^\/\d+$/.test(path)) return null;

  const authority = pathAt === -1 ? beforeQuery : beforeQuery.slice(0, pathAt);
  // One `@` separates an optional `:password@` from the host list. Two are ambiguous — the
  // classic unencoded-`@`-in-password trap upstream's own MongoDB reader refuses — so the
  // string is refused and the password percent-encoded next time, never guessed at.
  const ats = authority.match(/@/g);
  if (ats !== null && ats.length > 1) return null;
  let password: string | undefined;
  let hostList = authority;
  if (ats !== null) {
    const at = authority.indexOf("@");
    const userinfo = authority.slice(0, at);
    if (userinfo === "" || !userinfo.startsWith(":")) return null;
    const decoded = safeDecode(userinfo.slice(1));
    password = decoded === "" ? undefined : decoded;
    hostList = authority.slice(at + 1);
  }

  const sentinels = parseSentinelNodes(hostList);
  if (sentinels === null) return null;

  return {
    masterName,
    sentinels,
    ...(password !== undefined ? { password } : {}),
    ...(params.has("sentinelpassword") ? { sentinelPassword: params.get("sentinelpassword") } : {}),
    ...(path !== "" ? { database: Number(path.slice(1)) } : {}),
    tls: SECURE_SENTINEL_SCHEME.test(text),
  };
}

/**
 * The S4 entry: the Sentinel options for a connection, or `{}` when it is not a Sentinel
 * connection — the seam spreads this after the provider's own options, so an empty answer
 * changes nothing and upstream behaviour is bit-identical.
 *
 * When the string opts in, ioredis switches to its SentinelConnector on the presence of
 * `sentinels` alone (built/Redis.js), and the master's address is asked of the sentinels on
 * every connect and reconnect — which is what makes a failover transparent. The base options
 * upstream built (`host`, `port`, `connectTimeout`, `lazyConnect`, …) ride along untouched;
 * `host`/`port` are inert in sentinel mode, and `connectTimeout` is what the sentinel hops
 * take too (SentinelConnector's `connectToSentinel` reads it).
 *
 * The defaulting rule is the old fork's, for the deployment it was measured against: a chart
 * that protects Redis and Sentinel with one secret (Bitnami's `sentinel.enabled`) sets only
 * the Redis password, so `sentinelPassword` falls back to the string's `:password@`, then to
 * the connection's own `password` field. A sentinel that requires no password still answers —
 * ioredis logs the refused AUTH and carries on.
 *
 * Never throws, on any input: the seam sits inside the provider's `openClient`, where a throw
 * would be a 500 in upstream's words instead of a connection refused in the driver's.
 */
export function storagebaseSentinelOptions(config: DatabaseConnection): RedisOptions {
  try {
    const parsed = parseSentinelConnectionString(config.connectionString ?? "");
    if (parsed === null) return {};
    const sentinelPassword = parsed.sentinelPassword || parsed.password || config.password || undefined;
    return {
      sentinels: parsed.sentinels.map((node) => ({ host: node.host, port: node.port })),
      name: parsed.masterName,
      ...(parsed.database !== undefined ? { db: parsed.database } : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      ...(sentinelPassword !== undefined ? { sentinelPassword } : {}),
      sentinelRetryStrategy,
      ...(parsed.tls ? { tls: SENTINEL_TLS, enableTLSForSentinelMode: true, sentinelTLS: SENTINEL_TLS } : {}),
    };
  } catch {
    // A non-string `connectionString` from a JS caller's inline connection (`resolveConnection`
    // checks `type` and `name`, not this field) reaches `.trim` here. Anything the parser can
    // throw, the seam must answer for — with the empty options that keep upstream in charge.
    return {};
  }
}
