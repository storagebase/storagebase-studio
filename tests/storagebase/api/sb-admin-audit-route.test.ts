import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import type { ForkStore } from "@/storagebase/store/types";

/**
 * POST /api/sb/admin/audit: the guard (401), the role check the route owns (403, with the denial
 * audited), the fork error codes (SB_AUDIT_*), the store page, the buffered fallback, and the
 * export. `guardRoute` is mocked the way the upstream route tests mock it — what is proven here is
 * what the route does AFTER admission, which is the fork's own logic.
 */

type GuardAnswer = { response: NextResponse } | { session: { role: string; username: string } };

let guardAnswer: GuardAnswer = { session: { role: "admin", username: "admin" } };
const roleDenials: string[] = [];

mock.module("@/lib/api/require-session", () => ({
  guardRoute: async () => guardAnswer,
  adminRequiredResponse: () =>
    NextResponse.json({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" }, { status: 403 }),
  auditRoleDenial: (opts: { route: string; user: string }) => {
    roleDenials.push(`${opts.user}@${opts.route}`);
  },
}));

let store: ForkStore | null = null;
let openError: Error | null = null;
mock.module("@/storagebase/store", () => ({
  getForkStore: async () => {
    if (openError) throw openError;
    return store;
  },
}));

// The sink's ring is pinned at the module boundary: the fallback reads it beside upstream's own
// buffer, and a test can make it fail without loading the real sink's queue machinery.
const ringControl = { events: [] as unknown[], throw: false };
mock.module("@/storagebase/audit/sink", () => ({
  storagebaseBufferedAuditEvents: () => {
    if (ringControl.throw) throw new Error("ring unreadable");
    return [...ringControl.events];
  },
}));

const { POST } = await import("@/app/api/sb/admin/audit/route");

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/sb/admin/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function event(id: string): {
  id: string;
  timestamp: string;
  type: string;
  action: string;
  target: string;
  user: string;
  result: string;
} {
  return {
    id,
    timestamp: `2026-09-24T10:0${id.at(-1)}:00.000Z`,
    type: "query_execution",
    action: "executed",
    target: "editor",
    user: "alice",
    result: "success",
  };
}

beforeEach(() => {
  guardAnswer = { session: { role: "admin", username: "admin" } };
  store = null;
  openError = null;
  roleDenials.length = 0;
  ringControl.events = [];
  ringControl.throw = false;
});

afterEach(() => {
  ringControl.events = [];
  ringControl.throw = false;
});

describe("POST /api/sb/admin/audit", () => {
  test("answers the guard's refusal as its own", async () => {
    guardAnswer = {
      response: NextResponse.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 }),
    };
    const res = await POST(post({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  test("refuses a non-admin session with the admin body, and records the denial", async () => {
    guardAnswer = { session: { role: "user", username: "bob" } };
    const res = await POST(post({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" });
    expect(roleDenials).toEqual(["bob@POST /api/sb/admin/audit"]);
  });

  test("refuses a body that is not a JSON object with the fork's own code", async () => {
    const res = await POST(post("not json at all"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid request body",
      code: "SB_AUDIT_INVALID_BODY",
      statusCode: 400,
    });
  });

  test("answers a page from the durable store, with the buffered total beside it", async () => {
    ringControl.events = [event("r1")];
    store = {
      queryAuditEvents: mock(async () => ({ events: [event("s1")], nextCursor: "next" })),
    } as unknown as ForkStore;
    const res = await POST(post({ limit: 25, type: "query_execution", user: " alice " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [event("s1")],
      nextCursor: "next",
      source: "store",
      total: 1,
    });
    // The filters were read, trimmed and passed through.
    const query = (store as unknown as { queryAuditEvents: (q: unknown) => Promise<unknown> }).queryAuditEvents;
    expect((query as unknown as ReturnType<typeof mock>).mock.calls[0][0]).toMatchObject({
      limit: 25,
      type: "query_execution",
      user: "alice",
    });
  });

  test("answers the buffered events when storage is local", async () => {
    ringControl.events = [event("r1"), event("r2")];
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "buffer", total: 2 });
  });

  test("falls back to the buffered events, logged, when the store cannot answer", async () => {
    ringControl.events = [event("r1")];
    openError = new Error("database down");
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const res = await POST(post({}));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ source: "buffer" });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a cursor this route did not mint is the caller's error, with the fork's own code", async () => {
    ringControl.events = [event("r1")];
    const res = await POST(post({ cursor: "not-a-cursor" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid audit cursor",
      code: "SB_AUDIT_INVALID_CURSOR",
      statusCode: 400,
    });
  });

  test("answers the export with every matching row and its bound", async () => {
    ringControl.events = [event("r1")];
    store = {
      queryAuditEvents: mock(async () => ({ events: [event("s1"), event("s2")], nextCursor: null })),
    } as unknown as ForkStore;
    const res = await POST(post({ export: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ source: "store", exported: 2, maxRows: 50_000 });
    expect(body.events).toHaveLength(2);
  });

  test("answers 500 with the fork's own code when the buffered events cannot be read", async () => {
    ringControl.throw = true;
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const res = await POST(post({}));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "The audit trail could not be read.",
        code: "SB_AUDIT_READ_FAILED",
        statusCode: 500,
      });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
