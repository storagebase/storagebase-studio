import { describe, expect, test } from "bun:test";
import { MAX_AUDIT_STATEMENT_LENGTH } from "@/lib/audit";
import { classifyAuditStatement, maskAuditErrorText, maskAuditStatement } from "@/lib/audit-sql";

/** The masked text alone, for the cases that only care about the rewrite. */
function mask(text: string, type?: Parameters<typeof maskAuditStatement>[1]): string {
  return maskAuditStatement(text, type).text;
}

describe("maskAuditStatement — SQL string literals", () => {
  test("replaces a single-quoted string with ?", () => {
    expect(mask("SELECT * FROM users WHERE password = 's3cr3t'", "postgres")).toBe(
      "SELECT * FROM users WHERE password = ?",
    );
  });

  test("treats a doubled quote as part of the literal, not its end", () => {
    expect(mask("SELECT 'it''s a secret' AS x", "postgres")).toBe("SELECT ? AS x");
  });

  test("treats a backslash-escaped quote as part of the literal", () => {
    expect(mask("SELECT 'a\\'b s3cr3t' FROM t", "mysql")).not.toContain("s3cr3t");
  });

  test("masks an unterminated string to the end of the input", () => {
    expect(mask("SELECT 'never closed s3cr3t", "postgres")).toBe("SELECT ?");
  });

  test("masks PostgreSQL dollar-quoted strings, tagged and untagged", () => {
    expect(mask("SELECT $$s3cr3t$$, $tag$more 'x' s3cr3t$tag$", "postgres")).toBe("SELECT ?, ?");
  });

  test("keeps positional placeholders, which are not literals", () => {
    expect(mask("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = ? AND d = :3", "postgres")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = ? AND d = :3",
    );
  });

  test("drops the typed-literal prefix with the literal: E'', N'', X'', B''", () => {
    expect(mask("SELECT E'a\\n', N'nat', X'DEADBEEF', B'1010' FROM t", "postgres")).toBe("SELECT ?, ?, ?, ? FROM t");
  });

  test("masks Oracle alternate quoting under the Oracle grammar", () => {
    expect(mask("SELECT q'{it's s3cr3t}' FROM dual", "oracle")).toBe("SELECT ? FROM dual");
  });

  test("masks literals inside a ClickHouse/PostgreSQL subscript", () => {
    expect(mask("SELECT m['s3cr3t'], arr[1] FROM t", "clickhouse")).toBe("SELECT m[?], arr[?] FROM t");
  });
});

describe("maskAuditStatement — numbers", () => {
  test("replaces integers, decimals and exponents", () => {
    expect(mask("SELECT 42, 3.14, .5, 1e10, 2.5E-3 FROM t LIMIT 10", "postgres")).toBe(
      "SELECT ?, ?, ?, ?, ? FROM t LIMIT ?",
    );
  });

  test("replaces hex and binary numeric literals", () => {
    expect(mask("SELECT 0xFF, 0b1010 FROM t", "mysql")).toBe("SELECT ?, ? FROM t");
  });

  test("keeps digits that are part of an identifier", () => {
    expect(mask("SELECT t1.col2, x_3 FROM table1 t1", "postgres")).toBe("SELECT t1.col2, x_3 FROM table1 t1");
  });

  test("keeps a MySQL identifier that starts with a digit", () => {
    expect(mask("SELECT 1col FROM t", "mysql")).toBe("SELECT 1col FROM t");
  });

  test("masks a negative number's digits and keeps the sign", () => {
    expect(mask("SELECT * FROM t WHERE a > -7", "postgres")).toBe("SELECT * FROM t WHERE a > -?");
  });
});

describe("maskAuditStatement — identifiers and comments", () => {
  test("keeps double-quoted, backtick and bracket identifiers", () => {
    expect(mask('SELECT "Col 1" FROM "my table"', "postgres")).toBe('SELECT "Col 1" FROM "my table"');
    expect(mask("SELECT `col 2` FROM `t`", "mysql")).toBe("SELECT `col 2` FROM `t`");
    expect(mask("SELECT [col 3] FROM [dbo].[t]", "mssql")).toBe("SELECT [col 3] FROM [dbo].[t]");
  });

  test("keeps a digit inside a quoted identifier", () => {
    expect(mask('SELECT "2024" FROM t', "postgres")).toBe('SELECT "2024" FROM t');
  });

  test("strips line and block comments, including one that carries a literal", () => {
    expect(mask("SELECT 1 -- password 's3cr3t'\nFROM t /* token 123 */ WHERE x = 'y'", "postgres")).toBe(
      "SELECT ? FROM t WHERE x = ?",
    );
  });

  test("strips a MySQL # comment", () => {
    expect(mask("SELECT a FROM t # s3cr3t", "mysql")).toBe("SELECT a FROM t");
  });

  test("collapses whitespace so the masked statement reads on one line", () => {
    expect(mask("SELECT\n  a,\n\tb\r\nFROM   t", "postgres")).toBe("SELECT a, b FROM t");
  });

  test("masks every literal of a multi-statement script", () => {
    expect(mask("INSERT INTO t VALUES ('a', 1); UPDATE t SET b = 'c' WHERE id = 2;", "sqlite")).toBe(
      "INSERT INTO t VALUES (?, ?); UPDATE t SET b = ? WHERE id = ?;",
    );
  });

  test("uses the compatibility grammar when no dialect is named", () => {
    expect(mask("SELECT 'x' FROM t")).toBe("SELECT ? FROM t");
  });
});

describe("maskAuditStatement — bounds", () => {
  test("reports an untruncated statement as such", () => {
    expect(maskAuditStatement("SELECT 1", "postgres")).toEqual({ text: "SELECT ?", truncated: false });
  });

  test("bounds the masked text and says so", () => {
    const long = `SELECT ${"a, ".repeat(5000)}b FROM t`;
    const masked = maskAuditStatement(long, "postgres");
    expect(masked.text.length).toBe(MAX_AUDIT_STATEMENT_LENGTH);
    expect(masked.truncated).toBe(true);
  });

  test("never lets a literal survive the input cap, even one cut in half", () => {
    const long = `SELECT '${"s3cr3t".repeat(20_000)}' FROM t`;
    const masked = maskAuditStatement(long, "postgres");
    expect(masked.text).toBe("SELECT ?");
    expect(masked.truncated).toBe(true);
  });

  test("returns an empty string for blank input", () => {
    expect(maskAuditStatement("   ", "postgres")).toEqual({ text: "", truncated: false });
  });
});

describe("maskAuditStatement — MongoDB documents", () => {
  test("keeps collection, operation and every key, masking every value", () => {
    const query = JSON.stringify({
      collection: "users",
      operation: "find",
      filter: { email: "a@b.com", age: { $gt: 30 }, active: true, deleted: null, tags: ["x", 2] },
    });
    expect(mask(query, "mongodb")).toBe(
      '{"collection":"users","operation":"find","filter":{"email":"?","age":{"$gt":"?"},"active":"?","deleted":null,"tags":["?","?"]}}',
    );
  });

  test("masks the values of an aggregate pipeline", () => {
    const query = JSON.stringify({
      collection: "orders",
      operation: "aggregate",
      pipeline: [{ $match: { token: "s3cr3t" } }],
    });
    expect(mask(query, "mongodb")).not.toContain("s3cr3t");
  });

  test("keeps no field of a document that is not JSON at all", () => {
    expect(mask('{ "collection": "users", "filter": { "pw": "s3cr3t" ', "mongodb")).toBe("[unreadable document]");
  });

  test("keeps no field of a document too large to mask", () => {
    const query = JSON.stringify({ collection: "t", operation: "find", filter: { a: "s".repeat(70_000) } });
    expect(maskAuditStatement(query, "mongodb")).toEqual({ text: "[unreadable document]", truncated: true });
  });

  test("masks a top-level array or scalar document", () => {
    expect(mask('["s3cr3t", 1]', "mongodb")).toBe('["?","?"]');
  });
});

describe("maskAuditStatement — Redis commands", () => {
  test("keeps the command name and masks every argument, key included", () => {
    expect(mask("SET session:alice s3cr3t EX 60", "redis")).toBe("SET ? ? ? ?");
  });

  test("treats a quoted argument with spaces as one argument", () => {
    expect(mask('SET greeting "hello s3cr3t world"', "redis")).toBe("SET ? ?");
    expect(mask("SET greeting 'it s3cr3t'", "redis")).toBe("SET ? ?");
  });

  test("drops # comment lines and blank-line-separated alternatives", () => {
    expect(mask("# note s3cr3t\nGET k\n\nDEL other", "redis")).toBe("GET ?");
  });

  test("masks the arguments of the JSON command form", () => {
    expect(mask('{ "command": "HSET", "args": ["user:1", "pw", "s3cr3t"] }', "redis")).toBe(
      '{"command":"HSET","args":["?","?","?"]}',
    );
  });

  test("skips leading blank lines before the command", () => {
    expect(mask("\n\n  \nGET k", "redis")).toBe("GET ?");
  });

  test("keeps a quoted argument open across lines, as the provider does", () => {
    expect(mask('SET note "line1\n\n# not a comment"\nEX 5', "redis")).toBe("SET ? ? ? ?");
  });

  test("an argument-free command is just its name", () => {
    expect(mask("PING", "redis")).toBe("PING");
  });

  test("masks a first word that is not shaped like a command name", () => {
    expect(mask("s3cr3t value", "mongodb")).toBe("? ?");
  });

  test("a buffer with only comments masks to nothing", () => {
    expect(mask("# only a comment", "redis")).toBe("");
  });
});

describe("classifyAuditStatement", () => {
  test.each([
    ["SELECT 1", "SELECT"],
    ["insert into t values (1)", "INSERT"],
    ["UPDATE t SET a = 1", "UPDATE"],
    ["DELETE FROM t", "DELETE"],
    ["CREATE TABLE t (a int)", "DDL"],
    ["DROP TABLE t", "DDL"],
    ["VACUUM", "OTHER"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "SELECT"],
  ])("reads %p as %p", (sql, kind) => {
    expect(classifyAuditStatement(sql, "postgres")).toBe(kind as never);
  });

  test.each([
    ["find", "SELECT"],
    ["findOne", "SELECT"],
    ["aggregate", "SELECT"],
    ["count", "SELECT"],
    ["distinct", "SELECT"],
    ["insertOne", "INSERT"],
    ["insertMany", "INSERT"],
    ["updateOne", "UPDATE"],
    ["updateMany", "UPDATE"],
    ["deleteOne", "DELETE"],
    ["deleteMany", "DELETE"],
    ["drop", "OTHER"],
  ])("reads a MongoDB %p as %p", (operation, kind) => {
    expect(classifyAuditStatement(JSON.stringify({ collection: "c", operation }), "mongodb")).toBe(kind as never);
  });

  test("a document with no readable operation is OTHER", () => {
    expect(classifyAuditStatement("{ not json", "mongodb")).toBe("OTHER");
    expect(classifyAuditStatement("[1]", "mongodb")).toBe("OTHER");
    expect(classifyAuditStatement('{"operation": 3}', "mongodb")).toBe("OTHER");
  });

  test("a Redis command is OTHER", () => {
    expect(classifyAuditStatement("GET k", "redis")).toBe("OTHER");
  });
});

describe("maskAuditErrorText", () => {
  test("masks single, double and backtick quoted runs", () => {
    expect(maskAuditErrorText(`invalid input syntax for type integer: "s3cr3t" near 'x' in \`y\``)).toBe(
      "invalid input syntax for type integer: ? near ? in ?",
    );
  });

  test("masks an unterminated quoted run to the end", () => {
    expect(maskAuditErrorText("bad value 's3cr3t")).toBe("bad value ?");
  });

  test("masks a PostgreSQL key detail's value list", () => {
    expect(maskAuditErrorText("Key (email)=(alice@example.com) already exists.")).toBe(
      "Key (email)=(?) already exists.",
    );
    expect(maskAuditErrorText("Key (a)=(unclosed")).toBe("Key (a)=(?)");
  });

  test("masks free-standing numbers and keeps digits inside words", () => {
    expect(maskAuditErrorText("value 12345 out of range for column c2 at line 3")).toBe(
      "value ? out of range for column c2 at line ?",
    );
  });

  test("masks a number together with its unit suffix", () => {
    expect(maskAuditErrorText("timed out after 60000ms")).toBe("timed out after ?");
  });
});
