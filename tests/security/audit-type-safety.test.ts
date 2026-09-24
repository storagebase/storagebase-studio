import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer, sanitizeAuditInput } from "@/lib/audit";

/**
 * Threat: a non-string value reaching the authoritative stdout audit line unbounded, breaking the
 * fixed-shape `libredb.audit.v1` contract. `sanitizeAuditInput` (src/lib/audit.ts) sweeps only
 * `typeof value === "string"`, so a field that is supposed to be a string but isn't at runtime -
 * because a route destructured it straight out of an untyped `await request.json()` body - was
 * skipped by the sweep entirely and copied verbatim by `toAuditLine`.
 *
 * `POST /api/db/maintenance` is the real call site: it destructures `target` from the request body
 * and passes it through `emitAuditEvent` as the AuditEvent's `target` field (which becomes `route`
 * on the stdout line). Deliberately NOT mocking `@/lib/audit` here - the whole point is to exercise
 * the real sanitizer against the real route.
 */

const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
}));

const { POST } = await import("@/app/api/db/maintenance/route");

const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

describe("POST /api/db/maintenance audit type safety", () => {
  beforeEach(() => {
    clearRateLimitState();
    getServerAuditBuffer().clear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("a non-string target reaches the audit line as a bounded string, not a nested object", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const req = createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: {
          type: "vacuum",
          // A shape the AuditEvent type never produces but nothing at runtime rejects - `body` from
          // `await request.json()` is untyped, so this reaches emitAuditEvent's `target` field as-is.
          target: { nested: { token: "s3cr3t-value" } },
          connection: validConnection,
        },
      });

      const res = await POST(req as never);
      await parseResponseJSON(res);

      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;

      // The stdout line must never carry an object where the schema promises a string, and must
      // stay within the same bound every other free-text field is held to.
      expect(typeof line.route).toBe("string");
      expect((line.route as string).length).toBeLessThanOrEqual(254);

      // The buffer the admin UI serves shares the same sanitized event - not a second, looser rule.
      const buffered = getServerAuditBuffer().getAll();
      expect(buffered).toHaveLength(1);
      expect(typeof buffered[0].target).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Threat: `sanitizeAuditInput`'s coercion exemption for `duration` (the one AuditEvent field
 * legitimately typed as a number) must be keyed on the FIELD NAME, not merely on the runtime value
 * being a number - otherwise any other field arriving as a bare number (again, from an untyped
 * `await request.json()` body) would silently skip coercion the same way a nested object once did,
 * reaching the stdout line and the buffer as a raw number where the schema promises a string.
 */
describe("sanitizeAuditInput's duration exemption is keyed on the field name", () => {
  test("coerces a non-duration field to a string even when it arrives as a bare number", () => {
    const result = sanitizeAuditInput({
      type: "maintenance",
      action: "vacuum",
      // A shape the AuditEvent type never produces but nothing at runtime rejects.
      target: 42 as unknown as string,
      user: "admin",
      result: "success",
    });

    expect(typeof result.target).toBe("string");
    expect(result.target).toBe("42");
  });

  test("leaves a genuine duration number untouched", () => {
    const result = sanitizeAuditInput({
      type: "maintenance",
      action: "vacuum",
      target: "orders",
      user: "admin",
      result: "success",
      duration: 1500,
    });

    expect(result.duration).toBe(1500);
    expect(typeof result.duration).toBe("number");
  });
});

/**
 * The same rule for the fields the StorageBase fork added: the row counts keep their numbers and
 * the truncation flag its boolean, by NAME - so the client-supplied POST /api/admin/audit body
 * cannot put a raw number or boolean into a field whose schema promises a string, and cannot put a
 * string into the ones that promise a number.
 */
describe("sanitizeAuditInput's number and boolean exemptions are keyed on the field name", () => {
  test("keeps genuine row counts and the truncation flag", () => {
    const result = sanitizeAuditInput({
      type: "query_execution",
      action: "executed",
      target: "POST /api/db/query",
      user: "alice",
      result: "success",
      rowsReturned: 3,
      rowsAffected: 0,
      statementTruncated: true,
    });

    expect(result.rowsReturned).toBe(3);
    expect(result.rowsAffected).toBe(0);
    expect(result.statementTruncated).toBe(true);
  });

  test("coerces a boolean or a number that arrives in another field, and the wrong type in these", () => {
    const result = sanitizeAuditInput({
      type: "query_execution",
      action: "executed",
      target: true as unknown as string,
      user: "alice",
      result: "success",
      rowsReturned: "3" as unknown as number,
      statementTruncated: 1 as unknown as boolean,
    });

    expect(result.target).toBe("true");
    expect(result.rowsReturned).toBe("3" as unknown as number);
    expect(result.statementTruncated).toBe("1" as unknown as boolean);
  });
});

/**
 * `counts` is the one object-valued field, and the client-supplied POST /api/admin/audit body can
 * set it: it may only ever hold a handful of finite numbers and booleans under identifier-shaped
 * keys, so no string - a value, a body, a secret - can ride inside it to either destination.
 */
describe("sanitizeAuditInput bounds counts to numbers and booleans", () => {
  const base = {
    type: "resource_operation" as const,
    action: "tree.list",
    target: "s3:/",
    user: "u",
    result: "success" as const,
  };

  test("keeps at most MAX_AUDIT_COUNTS identifier-keyed numbers and booleans", () => {
    const counts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    const result = sanitizeAuditInput({ ...base, counts: { "bad key": 1, str: "x" as unknown as number, ...counts } });
    expect(Object.keys(result.counts ?? {})).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
  });

  test("drops counts that are not a plain object, or that keep nothing", () => {
    for (const counts of ["a string", [1, 2], null, { onlyText: "x" }]) {
      const result = sanitizeAuditInput({ ...base, counts: counts as unknown as Record<string, number> });
      expect("counts" in result).toBe(false);
    }
  });
});

/**
 * Threat: CodeQL's js/remote-property-injection (alerts #113/#114) - `sanitizeAuditInput` writes
 * through `mutable[key]` where `key` is enumerated from an object built by spreading
 * `POST /api/admin/audit`'s client-supplied JSON body (see src/app/api/admin/audit/route.ts). This
 * reproduces that exact shape: `JSON.parse` can produce an own property literally named
 * "__proto__" (it is not special to JSON.parse, only to certain assignment forms), and object
 * spread copies it as a plain own data property rather than resolving it as the prototype link.
 * DANGEROUS_KEYS skips it before the dynamic write, so the loop never even attempts
 * `mutable["__proto__"] = ...` - not relying on the spread's own accident of safety to hold.
 */
test("sanitizeAuditInput does not let an own __proto__ key from a spread JSON body reach the dynamic write", () => {
  const clientBody = JSON.parse('{"__proto__": {"polluted": "yes"}}') as Record<string, unknown>;
  const event = {
    ...clientBody,
    type: "maintenance",
    action: "vacuum",
    target: "orders",
    user: "admin",
    result: "success",
  } as unknown as Record<string, unknown>;

  expect(() => sanitizeAuditInput(event as never)).not.toThrow();
  const result = sanitizeAuditInput(event as never) as unknown as Record<string, unknown>;

  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  // Skipped, not deleted: the own "__proto__" property survives untouched (a pre-existing,
  // separately tracked residual - sanitizeAuditInput only sweeps top-level strings - not something
  // this guard is responsible for closing).
  expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
});
