import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { StoragebaseAuditEvent } from "@/storagebase/audit/types";
import { getServerAuditBuffer } from "@/lib/audit";
import { AuditQueryError, type ForkStore } from "@/storagebase/store/types";
import { logger } from "@/lib/logger";

let store: ForkStore | null = null;
let openError: Error | null = null;
mock.module("@/storagebase/store", () => ({
  getForkStore: async () => {
    if (openError) throw openError;
    return store;
  },
}));

// The buffered fallback reads the fork sink's ring beside upstream's own; both are pinned here so
// the union is asserted with the real shapes it serves.
const forkRing: StoragebaseAuditEvent[] = [];
mock.module("@/storagebase/audit/sink", () => ({
  storagebaseBufferedAuditEvents: () => [...forkRing],
}));

const { readAuditExport, readAuditPage, readAuditRequest, bufferedAuditEvents, AUDIT_EXPORT_MAX_ROWS } = await import(
  "@/storagebase/store/admin-query"
);

const buffered: StoragebaseAuditEvent[] = [
  {
    id: "b1",
    timestamp: "2026-09-24T10:00:00.000Z",
    type: "logout",
    action: "logout",
    target: "t",
    user: "u",
    result: "success",
  },
];

describe("readAuditRequest", () => {
  test("reads every filter, trims them, ignores empty and non-string ones, and defaults the page size", () => {
    expect(
      readAuditRequest({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-12-31T00:00:00.000Z",
        type: "resource_operation",
        action: "blob.download",
        user: " alice ",
        ip: "10.0.0",
        result: "failure",
        text: "report",
        engine: "s3",
        cursor: "abc",
        limit: 25,
        ignored: "x",
        text2: "",
        engine2: 7,
      }),
    ).toEqual({
      query: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-12-31T00:00:00.000Z",
        type: "resource_operation",
        action: "blob.download",
        user: "alice",
        ip: "10.0.0",
        result: "failure",
        text: "report",
        engine: "s3",
        cursor: "abc",
        limit: 25,
      },
      export: false,
    });
    expect(readAuditRequest({ limit: "nope", user: "" })).toEqual({ query: { limit: 100 }, export: false });
    expect(readAuditRequest({ limit: 0 })).toEqual({ query: { limit: 100 }, export: false });
    expect(readAuditRequest({ export: true })).toEqual({ query: { limit: 100 }, export: true });
  });
});

describe("readAuditPage", () => {
  beforeEach(() => {
    store = null;
    openError = null;
  });

  test("answers from the durable store when there is one", async () => {
    const stored = { ...buffered[0], id: "s1" };
    store = {
      queryAuditEvents: mock(async () => ({ events: [stored], nextCursor: "next" })),
    } as unknown as ForkStore;
    expect(await readAuditPage({ limit: 10 }, buffered)).toEqual({
      events: [stored],
      nextCursor: "next",
      source: "store",
    });
  });

  test("answers from the buffer when storage is local", async () => {
    expect(await readAuditPage({ limit: 10 }, buffered)).toEqual({
      events: buffered,
      nextCursor: null,
      source: "buffer",
    });
  });

  test("falls back to the buffer, logged, when the store cannot answer", async () => {
    openError = new Error("database down");
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await readAuditPage({ limit: 10 }, buffered)).source).toBe("buffer");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a bad cursor is the caller's error from the store too", async () => {
    store = {
      queryAuditEvents: mock(async () => {
        throw new AuditQueryError("Invalid audit cursor");
      }),
    } as unknown as ForkStore;
    await expect(readAuditPage({ limit: 10, cursor: "x" }, buffered)).rejects.toThrow("Invalid audit cursor");
  });
});

describe("readAuditExport", () => {
  beforeEach(() => {
    store = null;
    openError = null;
  });

  test("pages through the store until the cursor ends, one MAX page at a time", async () => {
    const calls: number[] = [];
    store = {
      queryAuditEvents: mock(async (query: { limit: number; cursor?: string }) => {
        calls.push(query.limit);
        if (query.cursor === undefined) {
          return {
            events: [{ ...buffered[0], id: `p${calls.length}` }],
            nextCursor: "second",
          };
        }
        return { events: [{ ...buffered[0], id: "last" }], nextCursor: null };
      }),
    } as unknown as ForkStore;
    const exported = await readAuditExport({ limit: 10 }, buffered);
    expect(exported.events.map((event) => event.id)).toEqual(["p1", "last"]);
    expect(exported.source).toBe("store");
    expect(calls).toEqual([1000, 1000]);
  });

  test("never answers past the export bound", async () => {
    let page = 0;
    store = {
      queryAuditEvents: mock(async () => {
        page += 1;
        const row = { ...buffered[0], id: `r${page}` };
        return {
          events: Array.from({ length: 1000 }, (_, i) => ({ ...row, id: `r${page}-${i}` })),
          nextCursor: "more",
        };
      }),
    } as unknown as ForkStore;
    const exported = await readAuditExport({ limit: 10 }, buffered);
    expect(exported.events).toHaveLength(AUDIT_EXPORT_MAX_ROWS);
    expect(page).toBe(AUDIT_EXPORT_MAX_ROWS / 1000);
  });

  test("serves the buffered events when there is no store", async () => {
    const exported = await readAuditExport({ limit: 10 }, buffered);
    expect(exported.events).toEqual(buffered);
    expect(exported.source).toBe("buffer");
  });
});

describe("bufferedAuditEvents", () => {
  test("serves the fork ring's events beside the upstream ring's, converted to the fork schema", () => {
    getServerAuditBuffer().clear();
    forkRing.length = 0;
    try {
      const forkEvent: StoragebaseAuditEvent = {
        id: "f1",
        timestamp: "2026-09-24T11:00:00.000Z",
        type: "query_execution",
        action: "executed",
        target: "editor",
        user: "alice",
        result: "success",
      };
      forkRing.push(forkEvent);
      getServerAuditBuffer().push({
        type: "logout",
        action: "logout",
        target: "POST /api/auth/logout",
        user: "bob",
        result: "success",
      });

      const served = bufferedAuditEvents();
      expect(served.map((event) => event.id)).toEqual(["f1", expect.any(String)]);
      expect(served[0]).toEqual(forkEvent);
      expect(served[1]).toMatchObject({
        type: "logout",
        action: "logout",
        user: "bob",
        result: "success",
      });
    } finally {
      getServerAuditBuffer().clear();
      forkRing.length = 0;
    }
  });
});
