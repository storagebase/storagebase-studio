import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { AuditEvent } from "@/lib/audit";
import { AuditQueryError, type ForkStore } from "@/lib/fork-store/types";
import { logger } from "@/lib/logger";

let store: ForkStore | null = null;
let openError: Error | null = null;
mock.module("@/lib/fork-store/index", () => ({
  getForkStore: async () => {
    if (openError) throw openError;
    return store;
  },
}));

const { readAuditPage, readAuditQuery } = await import("@/lib/fork-store/admin-query");

const buffered: AuditEvent[] = [
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

describe("readAuditQuery", () => {
  test("reads every filter, trims them, ignores empty ones, and defaults the page size", () => {
    expect(
      readAuditQuery(
        new URLSearchParams(
          "from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z&type=resource_operation&action=blob.download" +
            "&user=%20alice%20&ip=10.0.0&result=failure&text=report&engine=s3&cursor=abc&limit=25&ignored=x&text2=",
        ),
      ),
    ).toEqual({
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
    });
    expect(readAuditQuery(new URLSearchParams("limit=nope&user="))).toEqual({ limit: 100 });
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
