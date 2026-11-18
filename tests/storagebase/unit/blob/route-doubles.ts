import { mock } from "bun:test";

/**
 * Route-test doubles for the phase-3a blob tests. The fork spine itself is
 * REAL in these runs (handle-request's guard → parse → resolve → run, the
 * errors, the registry, the audit reason mapping); what stays doubled is
 * exactly what a unit test must control:
 *
 * - `@/lib/auth` — the session behind the REAL upstream `guardRoute`, so the
 *   guard-before-parse property stays a measured fact, exactly like the legacy
 *   route tests kept it;
 * - `@/storagebase/audit/resource` — the audited read/write recorders, so a
 *   route's audit SEMANTICS (one decision + one outcome on one correlation
 *   id, one event per read, never a value in any field) assert against a
 *   table rather than a sink; the real module's own tests hold the sink;
 * - `@/storagebase/resources/factory` — the provider double the routes
 *   resolve, so a route test answers without an SDK or a socket.
 *
 * The provider and auth-mode tests use no doubles beyond the two Azure SDK
 * modules (`mock.module("@azure/…")`, the legacy pattern): the provider loads
 * through the REAL spine chain — base-provider, registry, factory, sdk-loader.
 */

export const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

/**
 * The session reading upstream's `guardRoute` consumes (src/lib/auth's
 * `readSession`), chained through `mockGetSession` so a test toggles one
 * double for both spellings: `mockGetSession.mockResolvedValueOnce(null)`
 * is an anonymous caller.
 */
export const mockReadSession = mock(
  async (): Promise<{ kind: "authenticated" | "anonymous"; session?: { role: string; username: string } }> => {
    const session = await mockGetSession();
    return session === null ? { kind: "anonymous" } : { kind: "authenticated", session };
  },
);

// ── the factory double the routes resolve  ───────────────────────────────────────────────────────────

export const mockCreateResourceProvider = mock(async (config: { type: string }): Promise<unknown> => {
  throw new Error(`createResourceProvider is not doubled in this run (type ${config.type})`);
});

export const mockGetOrCreateResourceProvider = mock(async (): Promise<unknown> => undefined);

export const mockRemoveResourceProvider = mock(async () => undefined);

export const mockClearResourceProviderCache = mock(() => undefined);

export const mockTestResourceConnection = mock(async () => ({ success: true, degraded: false, message: "Connected" }));

// ── the audited read/write recorders  ───────────────────────────────────────────────────────────────

/** One audited read: the action, the address, and the outcome. */
export interface ResourceReadRecord {
  readonly action: string;
  readonly target: string;
  readonly result: "success" | "failure";
  readonly counts?: Record<string, unknown>;
}

/** One half of a write's decision/outcome pair, joined by the correlation id. */
export interface ResourceWriteRecord {
  readonly kind: "decision" | "outcome";
  readonly user: string;
  readonly action: string;
  readonly target: string;
  readonly correlationId: string;
  readonly error: unknown;
}

const resourceReads: ResourceReadRecord[] = [];
const resourceWrites: ResourceWriteRecord[] = [];
let correlationCounter = 0;
let writeSink: (record: ResourceWriteRecord) => void = (record) => {
  resourceWrites.push(record);
};

/** Make the next audit emit fail inside the audited-write double, the legacy broken-sink probe. */
export function breakResourceAuditSinkOnce(): void {
  const realSink = writeSink;
  writeSink = () => {
    writeSink = realSink;
    throw new Error("ring buffer full");
  };
}

const beginResourceWrite = mock((user: string, action: string, target: string): string => {
  const correlationId = `corr-${++correlationCounter}`;
  try {
    writeSink({ kind: "decision", user, action, target, correlationId, error: null });
  } catch {
    // The audited-write contract: a broken sink must not fail the write.
  }
  return correlationId;
});

const endResourceWrite = mock(
  (user: string, action: string, target: string, correlationId: string, error: unknown): void => {
    try {
      writeSink({ kind: "outcome", user, action, target, correlationId, error });
    } catch {
      // Same isolation as the decision half.
    }
  },
);

const auditedResourceRead = mock(
  async (
    _ctx: unknown,
    _request: Request,
    action: string,
    target: string,
    run: () => Promise<unknown>,
    details?: (result: unknown) => Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      const result = await run();
      let counts: Record<string, unknown> | undefined;
      try {
        counts = details?.(result);
      } catch {
        // A counting bug is logged, never turned into a failed read.
      }
      resourceReads.push({ action, target, result: "success", ...(counts === undefined ? {} : { counts }) });
      return result;
    } catch (error) {
      resourceReads.push({ action, target, result: "failure" });
      throw error;
    }
  },
);

export interface RouteDoubles {
  readonly reads: readonly ResourceReadRecord[];
  readonly writes: readonly ResourceWriteRecord[];
  resetRouteDoubles(): void;
}

/** Install the three route doubles. Call once, at the top of a test file, before importing the routes. */
export function installResourceRouteDoubles(): RouteDoubles {
  mock.module("@/lib/auth", () => ({
    getSession: mockGetSession,
    readSession: mockReadSession,
    signJWT: mock(async () => "mock-token"),
    verifyJWT: mock(async () => null),
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
  }));

  mock.module("@/storagebase/audit/resource", () => ({
    beginResourceWrite,
    endResourceWrite,
    auditedResourceRead,
  }));

  mock.module("@/storagebase/resources/factory", () => ({
    createResourceProvider: mockCreateResourceProvider,
    getOrCreateResourceProvider: mockGetOrCreateResourceProvider,
    removeResourceProvider: mockRemoveResourceProvider,
    clearResourceProviderCache: mockClearResourceProviderCache,
    testResourceConnection: mockTestResourceConnection,
  }));

  return {
    reads: resourceReads,
    writes: resourceWrites,
    resetRouteDoubles: () => {
      resourceReads.length = 0;
      resourceWrites.length = 0;
      correlationCounter = 0;
    },
  };
}
