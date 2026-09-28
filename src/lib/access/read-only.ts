import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { findCodeWord } from "@/lib/sql/words";
import type { DatabaseType } from "@/lib/types";

/**
 * Whether a statement only READS (StorageBase fork): the check a `read` grant on a managed database
 * connection runs before a statement reaches the engine.
 *
 * It reuses the readers the rest of the product already trusts rather than a new parser: the query
 * limiter's classifier (`analyzeQuery`, which the audit trail's `statementKind` also reads), the
 * dialect-aware statement splitter and code-word reader in src/lib/sql, and the MongoDB and Redis
 * operation readers of the confirmation gate. Every rule fails CLOSED — text it cannot read is not
 * read-only:
 *
 * - SQL: EVERY statement of the text must be a `SELECT` (a `WITH` typed by its operative keyword)
 *   or lead with `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN`, and no statement may carry a writing
 *   word anywhere in its code — which is what catches a data-modifying CTE, `SELECT … INTO`, and
 *   `SELECT … FOR UPDATE`. An unterminated literal or comment hides what follows it, so it refuses.
 * - MongoDB: `find`, `findOne`, `count`, `distinct`, or an `aggregate` with no `$out` / `$merge`.
 * - Redis: a command on the read list below. `CONFIG`, `CLIENT` and every scripting command are
 *   deliberately absent: `CONFIG GET requirepass` answers the server's password, and a script can
 *   do anything.
 *
 * What it cannot see, stated rather than hidden: a function with side effects called from a
 * `SELECT` (`SELECT pg_terminate_backend(…)`, `nextval`, a user-defined function that writes). The
 * database's own privileges are the real boundary; docs/ENTRA.md tells operators to give a `read`
 * connection a database role that can only read, and this check is the second line.
 */

const READ_LEADING_KEYWORDS: ReadonlySet<string> = new Set(["SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);

/** Words whose presence anywhere in a statement's code means it can change something. */
const WRITING_WORDS: readonly string[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "INTO",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "EXEC",
  "EXECUTE",
  "COPY",
];

const MONGODB_READ_OPERATIONS: ReadonlySet<string> = new Set(["find", "findOne", "count", "distinct", "aggregate"]);
const MONGODB_WRITING_STAGES: ReadonlySet<string> = new Set(["$out", "$merge"]);

const REDIS_READ_COMMANDS: ReadonlySet<string> = new Set([
  // strings and keys
  "GET",
  "MGET",
  "GETRANGE",
  "SUBSTR",
  "STRLEN",
  "LCS",
  "GETBIT",
  "BITCOUNT",
  "BITPOS",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "EXPIRETIME",
  "PEXPIRETIME",
  "KEYS",
  "SCAN",
  "RANDOMKEY",
  "DUMP",
  "TOUCH",
  // hashes, lists, sets, sorted sets
  "HGET",
  "HMGET",
  "HGETALL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "HSTRLEN",
  "HSCAN",
  "HRANDFIELD",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "LPOS",
  "SMEMBERS",
  "SISMEMBER",
  "SMISMEMBER",
  "SCARD",
  "SSCAN",
  "SRANDMEMBER",
  "SINTER",
  "SINTERCARD",
  "SUNION",
  "SDIFF",
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZRANGEBYLEX",
  "ZREVRANGE",
  "ZREVRANGEBYSCORE",
  "ZREVRANGEBYLEX",
  "ZSCORE",
  "ZMSCORE",
  "ZRANK",
  "ZREVRANK",
  "ZCARD",
  "ZCOUNT",
  "ZLEXCOUNT",
  "ZSCAN",
  "ZRANDMEMBER",
  "ZINTER",
  "ZUNION",
  "ZDIFF",
  // streams, geo, hyperloglog
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "XREAD",
  "XPENDING",
  "GEOPOS",
  "GEODIST",
  "GEOHASH",
  "GEORADIUS_RO",
  "GEORADIUSBYMEMBER_RO",
  "GEOSEARCH",
  "PFCOUNT",
  // server facts that carry no secret
  "DBSIZE",
  "INFO",
  "PING",
  "ECHO",
  "TIME",
  "LASTSAVE",
  // modules
  "JSON.GET",
  "JSON.MGET",
  "JSON.TYPE",
  "JSON.STRLEN",
  "JSON.OBJKEYS",
  "JSON.OBJLEN",
  "JSON.ARRLEN",
  "JSON.RESP",
  "FT.SEARCH",
  "FT.AGGREGATE",
  "FT.INFO",
  "FT._LIST",
  "FT.EXPLAIN",
  "TS.GET",
  "TS.MGET",
  "TS.RANGE",
  "TS.REVRANGE",
  "TS.MRANGE",
  "TS.MREVRANGE",
  "TS.INFO",
  "TS.QUERYINDEX",
]);

/** Container commands readable only in these sub-command forms. */
const REDIS_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "XINFO STREAM",
  "XINFO GROUPS",
  "XINFO CONSUMERS",
  "OBJECT ENCODING",
  "OBJECT FREQ",
  "OBJECT IDLETIME",
  "OBJECT REFCOUNT",
  "MEMORY USAGE",
  "CLUSTER INFO",
  "CLUSTER NODES",
  "CLUSTER SLOTS",
  "CLUSTER SHARDS",
  "COMMAND COUNT",
  "COMMAND INFO",
  "COMMAND DOCS",
]);

export type ReadOnlyVerdict = { readOnly: true } | { readOnly: false; reason: string };

const READ_ONLY: ReadOnlyVerdict = { readOnly: true };

function refuse(reason: string): ReadOnlyVerdict {
  return { readOnly: false, reason };
}

function sqlVerdict(text: string, type: DatabaseType): ReadOnlyVerdict {
  const grammar = resolveSqlGrammar(type);
  if (hasUnterminatedSpan(text, grammar)) return refuse("the statement has an unterminated literal or comment");
  const statements = splitStatements(text, grammar);
  for (const { sql } of statements) {
    const kind = analyzeQuery(sql, type).type;
    const leading = readLeadingKeyword(sql, grammar)?.keyword;
    if (kind !== "SELECT" && !(leading !== undefined && READ_LEADING_KEYWORDS.has(leading))) {
      return refuse(`${leading ?? "this"} statements are not read-only`);
    }
    for (const word of WRITING_WORDS) {
      if (findCodeWord(sql, word, 0, grammar) !== null) return refuse(`the statement contains ${word}`);
    }
  }
  return READ_ONLY;
}

function mongodbVerdict(text: string): ReadOnlyVerdict {
  const names = NON_SQL_DESTRUCTIVE_VOCABULARY.mongodb?.read(text);
  if (names === undefined || names.length === 0) return refuse("the document names no readable operation");
  const [operation, ...stages] = names;
  if (!MONGODB_READ_OPERATIONS.has(operation)) return refuse(`${operation} is not a read operation`);
  const writing = stages.find((stage) => MONGODB_WRITING_STAGES.has(stage));
  return writing === undefined ? READ_ONLY : refuse(`the pipeline writes with ${writing}`);
}

function redisVerdict(text: string): ReadOnlyVerdict {
  const names = NON_SQL_DESTRUCTIVE_VOCABULARY.redis?.read(text);
  if (names === undefined || names.length === 0) return refuse("no command could be read");
  const [command, withSubcommand] = names;
  if (REDIS_READ_COMMANDS.has(command)) return READ_ONLY;
  if (withSubcommand !== undefined && REDIS_READ_SUBCOMMANDS.has(withSubcommand)) return READ_ONLY;
  return refuse(`${command} is not a read command`);
}

export function readOnlyVerdict(text: string, type: DatabaseType): ReadOnlyVerdict {
  if (type === "mongodb") return mongodbVerdict(text);
  if (type === "redis") return redisVerdict(text);
  return sqlVerdict(text, type);
}
