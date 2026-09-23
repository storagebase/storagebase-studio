import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { readsSqlText, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { IDENTIFIER_PART, readSqlSpan } from "@/lib/sql/spans";
import { MAX_AUDIT_STATEMENT_LENGTH, type AuditStatementKind } from "@/lib/audit";
import type { DatabaseType } from "@/lib/types";

/**
 * The statement text a `query_execution` audit event may carry (StorageBase fork).
 *
 * The audit trail used to carry no SQL at all, on the rule that SQL text is the product's data. An
 * operator asked "who ran WHICH query" cannot be answered without it, so the rule is now narrower:
 * the STRUCTURE of a statement is recorded, its VALUES never are. A literal is where a statement
 * carries data - `WHERE password = 's3cr3t'`, `VALUES ('alice@example.com', 4111111111111111)` - and
 * a log pipeline is a far wider audience than the database the value was sent to, so every literal
 * is replaced with `?` before the text becomes an event field, and the raw text never reaches one.
 *
 * What is kept: keywords, identifiers (bare and quoted - a quoted name is a name, not a value),
 * operators, placeholders (`$1`, `?`, `:1`), and the shape. What is dropped: string literals of
 * every quoting form the span reader knows (`'…'`, dollar quotes, Oracle `q'…'`, together with an
 * `E`/`N`/`X`/`B` type prefix), numeric literals (decimal, exponent, hex, binary), and comments,
 * which are free text a person may have pasted anything into.
 *
 * The walk reads through `src/lib/sql/spans.ts` with the connection's own grammar rather than a
 * regex: that module already knows where every dialect's literals and comments end, and a masker
 * that disagreed with it about where a string ends would put the tail of a literal into the log.
 *
 * Known gap, stated rather than hidden: MySQL with its default `sql_mode` reads `"…"` as a STRING,
 * and the shared span reader reports it as a quoted identifier (it is one in every other dialect
 * here), so a MySQL literal written in double quotes is kept verbatim. Single quotes are masked on
 * every engine.
 */

/**
 * How much input the masker reads. Past this the input is cut BEFORE masking, which is safe by
 * construction: a literal cut in half is an unterminated span, and an unterminated span is masked
 * to the end of the input rather than emitted.
 */
const MAX_MASK_INPUT_LENGTH = 65_536;

/** What a document that cannot be parsed, or is too large to parse, masks to: nothing of it. */
const UNREADABLE_DOCUMENT = "[unreadable document]";

const MASK = "?";

/** The single-letter prefixes that type the string literal right after them: E'', N'', X'', B''. */
const LITERAL_PREFIXES = new Set(["E", "N", "X", "B"]);

/**
 * Top-level document fields that name WHERE a document goes rather than carrying data: a MongoDB
 * query's collection and operation, and a Redis JSON command's name. Everything else in a document
 * is a value and is masked.
 */
const DOCUMENT_STRUCTURE_KEYS = new Set(["collection", "operation", "command"]);

/** A Redis command name: letters, with a dot for module commands (`JSON.GET`, `FT.SEARCH`). */
const COMMAND_NAME = /^[A-Za-z][A-Za-z.]{0,31}$/;

export interface MaskedStatement {
  /** The statement with every literal replaced by `?`, bounded to MAX_AUDIT_STATEMENT_LENGTH. */
  text: string;
  /** Whether the input or the masked text was cut to fit a bound. */
  truncated: boolean;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && (IDENTIFIER_PART.test(ch) || ch === "$");
}

function isHexDigit(ch: string | undefined): boolean {
  return isDigit(ch) || (ch !== undefined && /[a-fA-F]/.test(ch));
}

/** One past the end of the identifier-shaped word starting at `index`. */
function wordEnd(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWordChar(text[i])) i++;
  return i;
}

/**
 * One past the end of the numeric literal starting at `index` (a digit, or a `.` before one), or
 * -1 when the run turns out to be the start of a name (`1col`, legal in MySQL).
 */
function numberEnd(text: string, index: number): number {
  let i = index;
  const radix = text[i] === "0" ? text[i + 1] : undefined;
  if ((radix === "x" || radix === "X") && isHexDigit(text[i + 2])) {
    i += 2;
    while (isHexDigit(text[i])) i++;
  } else if ((radix === "b" || radix === "B") && (text[i + 2] === "0" || text[i + 2] === "1")) {
    i += 2;
    while (text[i] === "0" || text[i] === "1") i++;
  } else {
    while (isDigit(text[i])) i++;
    if (text[i] === "." && isDigit(text[i + 1])) {
      i++;
      while (isDigit(text[i])) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      const sign = text[i + 1] === "+" || text[i + 1] === "-" ? 1 : 0;
      if (isDigit(text[i + 1 + sign])) {
        i += 1 + sign;
        while (isDigit(text[i])) i++;
      }
    }
  }
  return isWordChar(text[i]) ? -1 : i;
}

/**
 * Whether a number starting at `index` is a literal rather than part of a name or a placeholder:
 * `t1` and `$1`/`:1` carry digits that are not values.
 */
function startsNumericLiteral(text: string, index: number): boolean {
  const ch = text[index];
  const opens = isDigit(ch) || (ch === "." && isDigit(text[index + 1]));
  if (!opens) return false;
  const before = text[index - 1];
  return !isWordChar(before) && before !== ":" && before !== "@";
}

/** Append a separator, never two in a row and never at the start. */
function appendSpace(out: string): string {
  return out === "" || out.endsWith(" ") ? out : `${out} `;
}

function maskSql(sql: string, grammar: SqlGrammar): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null) {
      if (span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment") {
        out = appendSpace(out);
      } else if (span.kind === "string" || span.kind === "dollar-string") {
        out += MASK;
      } else if (span.kind === "subscript") {
        // A subscript is an expression, and a literal inside it is a literal: step into it.
        out += "[";
        i++;
        continue;
      } else {
        out += sql.slice(i, span.end);
      }
      i = span.end;
      continue;
    }

    if (startsNumericLiteral(sql, i)) {
      const end = numberEnd(sql, i);
      if (end !== -1) {
        out += MASK;
        i = end;
        continue;
      }
    }

    if (isWordChar(sql[i])) {
      const end = wordEnd(sql, i);
      const word = sql.slice(i, end);
      // A type prefix goes with the literal it types: `X'DEADBEEF'` masks to `?`, not `X?`.
      if (!(LITERAL_PREFIXES.has(word.toUpperCase()) && sql[end] === "'")) out += word;
      i = end;
      continue;
    }

    out += sql[i];
    i++;
  }

  return out.trim();
}

/** Every value in a parsed document replaced by `?`, every key kept. */
function maskDocumentValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(maskDocumentValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskDocumentValue(inner)]));
  }
  return MASK;
}

function maskDocument(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNREADABLE_DOCUMENT;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify(maskDocumentValue(parsed));
  }
  const masked = Object.entries(parsed).map(([key, value]) => [
    key,
    DOCUMENT_STRUCTURE_KEYS.has(key) && typeof value === "string" ? value : maskDocumentValue(value),
  ]);
  return JSON.stringify(Object.fromEntries(masked));
}

/**
 * The words of the first command in a Redis buffer, read with the provider's own plain-command
 * rules (`src/lib/db/providers/keyvalue/redis.ts`): `#` lines are comments, a blank line ends the
 * command, and `"…"` / `'…'` group an argument with no escape handling.
 */
function redisWords(text: string): string[] {
  const words: string[] = [];
  let current: string | null = null;
  let quote = "";

  for (const line of text.split("\n")) {
    if (quote === "") {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      if (trimmed === "") {
        // Every line ends in a word break, so a word is never still open here.
        if (words.length > 0) break;
        continue;
      }
    }
    for (const ch of `${line}\n`) {
      if (quote !== "") {
        if (ch === quote) quote = "";
        else current = `${current ?? ""}${ch}`;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current = current ?? "";
      } else if (ch.trim() === "") {
        if (current !== null) words.push(current);
        current = null;
      } else {
        current = `${current ?? ""}${ch}`;
      }
    }
  }
  if (current !== null) words.push(current);
  return words;
}

/**
 * A Redis command keeps its NAME and nothing else. The key is masked with the values: keys are
 * where applications put identities (`session:alice`, `user:alice@example.com:cart`), so a key is
 * data by this module's rule, and a masked argument still shows how many arguments there were.
 */
function maskCommand(text: string): string {
  const [name, ...args] = redisWords(text);
  if (name === undefined) return "";
  // Only a word shaped like a command name is kept as one (`GET`, `JSON.GET`): this branch also
  // receives whatever non-JSON text was typed at a document engine, where the first word can be
  // anything at all.
  return [COMMAND_NAME.test(name) ? name : MASK, ...args.map(() => MASK)].join(" ");
}

function bound(text: string, inputTruncated: boolean): MaskedStatement {
  if (text.length > MAX_AUDIT_STATEMENT_LENGTH) {
    return { text: text.slice(0, MAX_AUDIT_STATEMENT_LENGTH), truncated: true };
  }
  return { text, truncated: inputTruncated };
}

/**
 * The statement with every literal masked, in the grammar of the engine it ran on. Non-SQL text is
 * read by its shape - a JSON document (MongoDB, Redis's JSON form) or a Redis command line -
 * because `readsSqlText` is the one place that decides which dialects are not SQL.
 */
export function maskAuditStatement(text: string, type?: DatabaseType): MaskedStatement {
  const inputTruncated = text.length > MAX_MASK_INPUT_LENGTH;

  if (readsSqlText(type)) {
    return bound(maskSql(text.slice(0, MAX_MASK_INPUT_LENGTH), resolveSqlGrammar(type)), inputTruncated);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    // A document cut in half does not parse, and a guess at its fields is not worth the risk.
    if (inputTruncated) return { text: UNREADABLE_DOCUMENT, truncated: true };
    return bound(maskDocument(trimmed), false);
  }
  return bound(maskCommand(text.slice(0, MAX_MASK_INPUT_LENGTH)), inputTruncated);
}

/** MongoDB's operations, in the provider's spelling, by the statement kind they are. */
const DOCUMENT_OPERATION_KINDS: Readonly<Record<string, AuditStatementKind>> = {
  find: "SELECT",
  findOne: "SELECT",
  aggregate: "SELECT",
  count: "SELECT",
  distinct: "SELECT",
  insertOne: "INSERT",
  insertMany: "INSERT",
  updateOne: "UPDATE",
  updateMany: "UPDATE",
  deleteOne: "DELETE",
  deleteMany: "DELETE",
};

function classifyDocument(text: string): AuditStatementKind {
  try {
    const parsed: unknown = JSON.parse(text);
    const operation =
      typeof parsed === "object" && parsed !== null ? (parsed as { operation?: unknown }).operation : undefined;
    if (typeof operation === "string" && Object.hasOwn(DOCUMENT_OPERATION_KINDS, operation)) {
      return DOCUMENT_OPERATION_KINDS[operation];
    }
  } catch {
    // An unreadable document has no kind to report.
  }
  return "OTHER";
}

/**
 * What kind of statement this is. SQL reads through the query limiter's own classifier
 * (`analyzeQuery`), so the audit trail and the row bound can never disagree about whether a
 * statement is a SELECT; a MongoDB document reads by its `operation`; a Redis command is OTHER.
 */
export function classifyAuditStatement(text: string, type?: DatabaseType): AuditStatementKind {
  if (readsSqlText(type)) return analyzeQuery(text, type).type;
  return text.trim().startsWith("{") ? classifyDocument(text) : "OTHER";
}

/**
 * A driver's error sentence with the values it quotes masked. Drivers echo the offending value
 * back - `invalid input syntax for type integer: "s3cr3t"`, `Key (email)=(alice@example.com)
 * already exists` - so an error message is as much a carrier of literals as the statement is.
 * Quoted runs of every quote character, a key detail's value list and free-standing numbers are
 * masked; the words around them are kept so the event still says what went wrong.
 */
export function maskAuditErrorText(message: string): string {
  const text = message.slice(0, MAX_MASK_INPUT_LENGTH);
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = text.indexOf(ch, i + 1);
      out += MASK;
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (text.startsWith("=(", i)) {
      const close = text.indexOf(")", i + 2);
      out += `=(${MASK})`;
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (startsNumericLiteral(text, i)) {
      // Prose has no names that start with a digit, so a unit suffix goes with its number
      // (`60000ms`), where the SQL reader has to keep a MySQL name like `1col` whole.
      const end = numberEnd(text, i);
      out += MASK;
      i = end === -1 ? wordEnd(text, i) : end;
      continue;
    }
    if (isWordChar(ch)) {
      const end = wordEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }

  return out;
}
