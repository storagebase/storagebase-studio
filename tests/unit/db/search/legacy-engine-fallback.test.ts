/**
 * OpenSearch legacy SQL engine fallback for custom-format date fields
 *
 * The defect, measured against OpenSearch 2.7.0 on 2026-09-23: an index whose
 * mapping carries a `date` field with a CUSTOM format (`"format": "uuuu-MM-dd
 * HH:mm:ss.SSS"`, a common log-pipeline mapping) cannot be read by the SQL plugin's
 * new engine at all once that field is projected:
 *
 * - `POST /_plugins/_sql` (the new engine, JDBC envelope) answers HTTP 503,
 *   `IllegalStateException`, "Construct ExprTimestampValue from \"2026-09-12
 *   23:59:59.854\" failed, unsupported date format.";
 * - `POST /_plugins/_ppl` refuses the same way;
 * - `POST /_plugins/_sql?format=json` routes to the LEGACY engine and answers HTTP 200
 *   with a raw search response - `hits.hits[]._source`;
 * - projecting only non-date columns through the new engine works.
 *
 * So the transport asks the legacy engine ONCE, for that fault alone, for a SELECT
 * alone, and on OpenSearch alone. These tests drive the real transport and the real
 * provider against a fake `fetch`; the legacy body below is shaped after the measured
 * answer with generic names (index `app-logs`, field `timestamp`), not captured
 * verbatim from any real cluster.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import { ElasticsearchProvider, OpenSearchProvider } from "@/lib/db/providers/sql/search";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import { SearchTransportError } from "@/lib/db/providers/sql/search/transport";
import { QueryError } from "@/lib/db/errors";

// ============================================================================
// Wire bodies
// ============================================================================

const DATE_FAULT_DETAIL =
  'Construct ExprTimestampValue from "2026-09-12 23:59:59.854" failed, unsupported date format.';

/** The new engine's refusal, in the shape and at the status measured on 2.7.0. */
const DATE_FAULT_BODY = JSON.stringify({
  error: {
    reason: "There was internal problem at backend",
    details: DATE_FAULT_DETAIL,
    type: "IllegalStateException",
  },
  status: 503,
});

/** The connect probe's answer. */
const PROBE_BODY = JSON.stringify({ schema: [{ name: "1", type: "integer" }], datarows: [[1]], total: 1, size: 1 });

/**
 * The legacy engine's answer: a raw search response. The two documents do not carry
 * the same fields, which is what the column union has to survive, and one carries an
 * object value, which is served as the sub-document the new engine also serves.
 */
const LEGACY_BODY = JSON.stringify({
  took: 3,
  timed_out: false,
  _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
  hits: {
    total: { value: 1520, relation: "eq" },
    max_score: 1,
    hits: [
      {
        _index: "app-logs",
        _id: "1",
        _score: 1,
        _source: { level: "INFO", timestamp: "2026-09-12 23:59:59.854", service: { name: "api" } },
      },
      {
        _index: "app-logs",
        _id: "2",
        _score: 1,
        _source: { level: "WARN", message: "slow response", timestamp: "2026-09-13 00:00:01.002" },
      },
    ],
  },
});

// ============================================================================
// Fake cluster
// ============================================================================

interface Reply {
  status?: number;
  body: string;
}

const originalFetch = globalThis.fetch;

let sentPaths: string[] = [];
let sentQueries: unknown[] = [];
/** What the new engine answers a user statement. */
let primary: Reply;
/** What the legacy engine answers, or a thrown value to simulate a failed request. */
let legacy: Reply | (() => never);

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "os-legacy",
    name: "OpenSearch",
    type: "opensearch",
    host: "127.0.0.1",
    port: 9200,
    createdAt: new Date(),
    ...overrides,
  };
}

function transport(): SearchHttpTransport {
  return new SearchHttpTransport("opensearch", connection());
}

beforeEach(() => {
  sentPaths = [];
  sentQueries = [];
  primary = { status: 503, body: DATE_FAULT_BODY };
  legacy = { body: LEGACY_BODY };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const query = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as { query?: unknown }).query;
    sentPaths.push(path);
    sentQueries.push(query);

    let reply: Reply;
    if (query === "SELECT 1") reply = { body: PROBE_BODY };
    else if (path === "/_plugins/_sql?format=json") {
      if (typeof legacy === "function") legacy();
      reply = legacy as Reply;
    } else reply = primary;

    return new Response(reply.body, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function faultOf(call: () => Promise<unknown>): Promise<SearchTransportError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof SearchTransportError) return error;
    throw error;
  }
  throw new Error("the call was expected to fail and did not");
}

// ============================================================================
// The fallback decision
// ============================================================================

describe("when the legacy engine is asked", () => {
  test("asks it once, after the new engine refuses a custom-format date", async () => {
    await transport().query("SELECT * FROM app-logs LIMIT 50");

    expect(sentPaths).toEqual(["/_plugins/_sql", "/_plugins/_sql?format=json"]);
    // The statement is sent unchanged: the limiter's bound is what caps the rows.
    expect(sentQueries).toEqual(["SELECT * FROM app-logs LIMIT 50", "SELECT * FROM app-logs LIMIT 50"]);
  });

  test("keeps the bound and offset the limiter wrote into the statement", async () => {
    await transport().query("SELECT * FROM app-logs LIMIT 50 OFFSET 100");

    expect(sentQueries[1]).toBe("SELECT * FROM app-logs LIMIT 50 OFFSET 100");
  });

  test.each([
    ["lowercase", "select * from app-logs"],
    ["leading whitespace", "\n  SELECT * FROM app-logs"],
    ["a leading line comment", "-- recent logs\nSELECT * FROM app-logs"],
    ["a leading block comment", "/* recent */ SELECT * FROM app-logs"],
  ])("recognises a SELECT with %s", async (_label, sql) => {
    await transport().query(sql);

    expect(sentPaths).toHaveLength(2);
  });

  test.each([
    ["DELETE", "DELETE FROM app-logs WHERE level = 'INFO'"],
    ["SHOW", "SHOW TABLES LIKE app%"],
    ["a word that only begins with select", "SELECTED FROM app-logs"],
  ])("never asks it for %s", async (_label, sql) => {
    const fault = await faultOf(() => transport().query(sql));

    expect(sentPaths).toEqual(["/_plugins/_sql"]);
    expect(fault.message).toStartWith(DATE_FAULT_DETAIL);
  });

  test("never asks it for another IllegalStateException", async () => {
    primary = {
      status: 503,
      body: JSON.stringify({
        error: { reason: "x", details: "Some other backend fault", type: "IllegalStateException" },
      }),
    };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(sentPaths).toEqual(["/_plugins/_sql"]);
    expect(fault.message).toBe("Some other backend fault");
  });

  test("never asks it for the same words under another fault name", async () => {
    primary = {
      status: 400,
      body: JSON.stringify({ error: { reason: "x", details: DATE_FAULT_DETAIL, type: "SemanticCheckException" } }),
    };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(sentPaths).toEqual(["/_plugins/_sql"]);
    expect(fault.message).toBe(DATE_FAULT_DETAIL);
  });

  test("never asks it on Elasticsearch, whose dialect has no legacy engine", async () => {
    const elasticsearch = new SearchHttpTransport("elasticsearch", connection({ type: "elasticsearch" }));

    const fault = await faultOf(() => elasticsearch.query("SELECT * FROM app-logs"));

    expect(sentPaths).toEqual(["/_sql?format=json"]);
    // Carried as Elasticsearch reads any envelope - its `reason` - with no hint appended.
    expect(fault.message).toBe("There was internal problem at backend");
  });
});

// ============================================================================
// When the legacy engine cannot help
// ============================================================================

describe("when the legacy engine cannot help", () => {
  test("returns the ORIGINAL fault, with a hint, when the legacy engine fails too", async () => {
    legacy = { status: 400, body: JSON.stringify({ error: { reason: "x", details: "legacy refusal", type: "X" } }) };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(fault.category).toBe("engine");
    expect(fault.engineType).toBe("IllegalStateException");
    expect(fault.message).toStartWith(DATE_FAULT_DETAIL);
    expect(fault.message).toContain("custom format");
    expect(fault.message).not.toContain("legacy refusal");
  });

  test("returns the original fault when the legacy request never completes", async () => {
    legacy = () => {
      throw new TypeError("fetch failed");
    };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(fault.message).toStartWith(DATE_FAULT_DETAIL);
  });

  test.each([
    ["an aggregation answer", { hits: { total: { value: 1 }, hits: [] }, aggregations: { c: { value: 1 } } }],
    ["a body with no hits", { took: 1 }],
    ["hits that are not a list", { hits: { hits: {} } }],
    ["a hit that is not an object", { hits: { hits: ["x"] } }],
    ["a hit with no source", { hits: { hits: [{ _id: "1" }] } }],
  ])("returns the original fault for %s, which is not rows", async (_label, body) => {
    legacy = { body: JSON.stringify(body) };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(fault.message).toStartWith(DATE_FAULT_DETAIL);
  });

  test("returns the original fault for a body that is not JSON", async () => {
    legacy = { body: "<html>proxy</html>" };

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs"));

    expect(fault.message).toStartWith(DATE_FAULT_DETAIL);
  });

  test("reports a deadline that expired during the legacy request as the deadline", async () => {
    legacy = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const controller = new AbortController();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    // The first request must still be answered, so only the legacy one sees the abort.
    let calls = 0;
    const fake = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return fake(input, calls === 1 ? { ...init, signal: undefined } : init);
    }) as typeof fetch;

    const fault = await faultOf(() => transport().query("SELECT * FROM app-logs", controller.signal));

    expect(fault.category).toBe("timeout");
  });
});

// ============================================================================
// Hits -> rows
// ============================================================================

describe("the legacy answer as rows", () => {
  test("unions the documents' fields in first-seen order and fills the gaps with null", async () => {
    const result = await transport().query("SELECT * FROM app-logs LIMIT 50");

    expect(result.fieldNames).toEqual(["level", "timestamp", "service", "message"]);
    expect(result.rows).toEqual([
      { level: "INFO", timestamp: "2026-09-12 23:59:59.854", service: { name: "api" }, message: null },
      { level: "WARN", timestamp: "2026-09-13 00:00:01.002", service: null, message: "slow response" },
    ]);
  });

  test("declares no column types, because the legacy answer carries none", async () => {
    const result = await transport().query("SELECT * FROM app-logs");

    expect(result.columnTypes).toBeNull();
  });

  test("reads the total from either spelling of hits.total", async () => {
    expect((await transport().query("SELECT * FROM app-logs")).totalHits).toBe(1520);

    legacy = { body: JSON.stringify({ hits: { total: 7, hits: [{ _source: { level: "INFO" } }] } }) };
    expect((await transport().query("SELECT * FROM app-logs")).totalHits).toBe(7);
  });

  test("describes no columns for an empty page rather than inventing them", async () => {
    legacy = { body: JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }) };

    const result = await transport().query("SELECT * FROM app-logs LIMIT 50 OFFSET 5000");

    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toBeNull();
  });

  test("does not read a field name off the prototype", async () => {
    legacy = {
      body: JSON.stringify({ hits: { hits: [{ _source: { constructor: "a" } }, { _source: { level: "INFO" } }] } }),
    };

    const result = await transport().query("SELECT * FROM app-logs");

    expect(result.rows[1]).toEqual({ constructor: null, level: "INFO" });
  });

  test("names the fallback and the refusal it replaced", async () => {
    const result = await transport().query("SELECT * FROM app-logs");

    expect(result.engineFallback).toEqual({ reason: "custom-date-format", primaryMessage: DATE_FAULT_DETAIL });
  });

  test("an ordinary answer names no fallback", async () => {
    primary = { body: PROBE_BODY };

    const result = await transport().query("SELECT level FROM app-logs");

    expect(result.engineFallback).toBeUndefined();
  });
});

// ============================================================================
// Through the provider
// ============================================================================

describe("OpenSearchProvider with a custom-format date field", () => {
  async function connected(): Promise<OpenSearchProvider> {
    const provider = new OpenSearchProvider(connection());
    await provider.connect();
    return provider;
  }

  test("returns the rows with a warning saying which engine served them", async () => {
    const provider = await connected();

    const result = await provider.query("SELECT * FROM app-logs LIMIT 50");

    expect(result.rowCount).toBe(2);
    expect(result.fields).toEqual(["level", "timestamp", "service", "message"]);
    expect(result).not.toHaveProperty("columnTypes");
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings ?? [];
    expect(warning?.message).toContain("legacy SQL engine");
    expect(warning?.message).toContain("custom format");
    expect(warning?.message).toContain(DATE_FAULT_DETAIL);
  });

  test("an ordinary answer carries no warning", async () => {
    const provider = await connected();
    primary = { body: PROBE_BODY };

    const result = await provider.query("SELECT level FROM app-logs");

    expect(result).not.toHaveProperty("warnings");
  });

  test("raises a query error that keeps the engine's words and adds the hint", async () => {
    const provider = await connected();
    legacy = { status: 500, body: "{}" };

    const failure = provider.query("SELECT * FROM app-logs LIMIT 50");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(DATE_FAULT_DETAIL);
    await expect(provider.query("SELECT * FROM app-logs")).rejects.toThrow(/select specific columns/i);
  });

  test("the Elasticsearch provider neither falls back nor adds the hint", async () => {
    const provider = new ElasticsearchProvider(connection({ type: "elasticsearch" }));
    primary = { body: JSON.stringify({ columns: [{ name: "1", type: "integer" }], rows: [[1]] }) };
    await provider.connect();
    primary = { status: 503, body: DATE_FAULT_BODY };

    const failure = provider.query("SELECT * FROM app-logs");

    await expect(failure).rejects.toThrow("There was internal problem at backend");
    await expect(failure).rejects.not.toThrow(/select specific columns/i);
    expect(sentPaths).not.toContain("/_plugins/_sql?format=json");
  });
});
