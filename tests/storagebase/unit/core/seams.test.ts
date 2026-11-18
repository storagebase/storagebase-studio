import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { AuditEvent } from "@/lib/audit";
import type { QueryEventInput } from "@/lib/query-events/types";

/**
 * The seams the upstream sinks call into (S2 and S3): importing the seams module costs nothing
 * (no sink is loaded until a tap runs), a tap loads the sink once and forwards to it fire-and-
 * forget, and a sink that cannot load or cannot record never turns into a failed query — the old
 * fork's invariant, on the new fork's lazy-import design.
 */

const recorded = {
  query: [] as QueryEventInput[],
  upstream: [] as AuditEvent[],
};

// The sink is replaced at the module boundary, so the tap's dynamic import resolves to this mock
// without loading the real sink's store chain.
mock.module("@/storagebase/audit/sink", () => ({
  storagebaseRecordQueryEvent: (input: QueryEventInput) => {
    recorded.query.push(input);
  },
  storagebaseRecordUpstreamEvent: (event: AuditEvent) => {
    recorded.upstream.push(event);
  },
}));

const { storagebaseAuditTap, storagebaseQueryTap } = await import("@/storagebase/core/seams");

/** The memo the seams module keeps the loaded sink under, cleared to force a reload. */
const SINK_MODULE_KEY = Symbol.for("storagebase.auditSinkModule");

function forgetLoadedSink(): void {
  delete (globalThis as Record<symbol, unknown>)[SINK_MODULE_KEY];
}

/** Awaits the tap's fire-and-forget chain, at most a moment: the load memo plus one microtask. */
async function settleTap(): Promise<void> {
  const holder = globalThis as Record<symbol, Promise<unknown> | undefined>;
  const loading = holder[SINK_MODULE_KEY];
  for (let i = 0; i < 50 && recorded.query.length === 0 && recorded.upstream.length === 0; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each wait is one turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (loading !== undefined) await loading;
}

function queryInput(): QueryEventInput {
  return {
    source: "editor",
    principal: { subject: "s", username: "alice", role: "user" },
    connection: { id: "c", name: null, engine: "postgres", accessLevel: "read" },
    statement: "SELECT 1",
    status: "success",
    started: { wallClockMs: Date.now(), monotonicMs: 0 },
  };
}

function upstreamEvent(): AuditEvent {
  return {
    id: "u1",
    timestamp: "2026-09-24T10:00:00.000Z",
    type: "logout",
    action: "logout",
    target: "POST /api/auth/logout",
    user: "alice",
    result: "success",
  };
}

describe("the audit taps", () => {
  beforeEach(() => {
    recorded.query.length = 0;
    recorded.upstream.length = 0;
    forgetLoadedSink();
  });

  test("a query tap loads the sink lazily and forwards the input", async () => {
    expect((globalThis as Record<symbol, unknown>)[SINK_MODULE_KEY]).toBeUndefined();
    storagebaseQueryTap(queryInput());
    await settleTap();
    expect(recorded.query).toHaveLength(1);
    expect(recorded.query[0]).toMatchObject({ source: "editor", status: "success" });
    // The load is memoized: a second tap does not start a second import.
    const loading = (globalThis as Record<symbol, Promise<unknown>>)[SINK_MODULE_KEY];
    storagebaseQueryTap(queryInput());
    await settleTap();
    expect((globalThis as Record<symbol, Promise<unknown>>)[SINK_MODULE_KEY]).toBe(loading);
    expect(recorded.query).toHaveLength(2);
  });

  test("an audit tap forwards the upstream event", async () => {
    storagebaseAuditTap(upstreamEvent());
    await settleTap();
    expect(recorded.upstream).toEqual([upstreamEvent()]);
  });

  test("a sink that cannot load is swallowed: the tap never throws and records nothing", async () => {
    // A rejection the test hands the memo only after the tap has attached its catch, so the
    // rejection is always handled — exactly the production shape the arm must cover.
    let refuseLoad: (error: Error) => void = () => {};
    (globalThis as Record<symbol, unknown>)[SINK_MODULE_KEY] = new Promise((_resolve, reject) => {
      refuseLoad = reject;
    });
    expect(() => storagebaseQueryTap(queryInput())).not.toThrow();
    expect(() => storagebaseAuditTap(upstreamEvent())).not.toThrow();
    refuseLoad(new Error("sink module broken"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded.query).toHaveLength(0);
    expect(recorded.upstream).toHaveLength(0);
  });

  test("a sink that throws while recording is swallowed: the tap never throws", async () => {
    // The memo is pre-seeded with a sink module whose record arms throw, so the tap's
    // fire-and-forget chain meets the throw where the catch has to swallow it.
    (globalThis as Record<symbol, unknown>)[SINK_MODULE_KEY] = Promise.resolve({
      storagebaseRecordQueryEvent: () => {
        throw new Error("sink exploded");
      },
      storagebaseRecordUpstreamEvent: () => {
        throw new Error("sink exploded");
      },
    });
    expect(() => storagebaseQueryTap(queryInput())).not.toThrow();
    expect(() => storagebaseAuditTap(upstreamEvent())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded.query).toHaveLength(0);
    expect(recorded.upstream).toHaveLength(0);
  });
});
