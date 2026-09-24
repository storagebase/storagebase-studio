import { describe, test, expect } from "bun:test";
import type { AuditEvent } from "@/lib/audit";
import { clampLimit, containsPattern, decodeCursor, encodeCursor, pageAuditEvents } from "@/lib/fork-store/query";
import { MAX_AUDIT_PAGE_SIZE } from "@/lib/fork-store";

/** The ring-buffer fallback must answer every filter the way the store's SQL does (sql-store.test.ts). */

function event(id: string, timestamp: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id,
    timestamp,
    type: "resource_operation",
    action: "tree.list",
    target: "s3:/",
    user: "alice",
    result: "success",
    ...overrides,
  };
}

const events: AuditEvent[] = [
  event("a", "2026-09-24T10:00:00.000Z"),
  event("b", "2026-09-24T11:00:00.000Z", {
    user: "Bob",
    ip: "198.51.100.7",
    engine: "kafka",
    action: "kafka.messages.read",
  }),
  event("c", "2026-09-24T11:00:00.000Z", { type: "query_execution", result: "failure", statement: "DELETE FROM t" }),
  event("d", "2026-09-24T12:00:00.000Z", { forwardedFor: "203.0.113.1, 10.0.0.1" }),
];

const ids = (query: Parameters<typeof pageAuditEvents>[1]) => pageAuditEvents(events, query).events.map((e) => e.id);

describe("pageAuditEvents", () => {
  test("pages newest first with ties broken by id, and follows the cursor", () => {
    const first = pageAuditEvents(events, { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["d", "c"]);
    const second = pageAuditEvents(events, { limit: 2, cursor: first.nextCursor! });
    expect(second.events.map((e) => e.id)).toEqual(["b", "a"]);
    expect(second.nextCursor).toBeNull();
  });

  test("filters the same fields the store filters", () => {
    expect(ids({ limit: 10, from: "2026-09-24T11:00:00.000Z", to: "2026-09-24T11:30:00.000Z" })).toEqual(["c", "b"]);
    expect(ids({ limit: 10, type: "query_execution" })).toEqual(["c"]);
    expect(ids({ limit: 10, action: "kafka.messages.read" })).toEqual(["b"]);
    expect(ids({ limit: 10, result: "failure" })).toEqual(["c"]);
    expect(ids({ limit: 10, engine: "kafka" })).toEqual(["b"]);
    expect(ids({ limit: 10, user: "bo" })).toEqual(["b"]);
    expect(ids({ limit: 10, ip: "10.0.0" })).toEqual(["d"]);
    expect(ids({ limit: 10, text: "delete from" })).toEqual(["c"]);
  });

  test("equal ids at one timestamp are a stable order", () => {
    const twins = [event("same", "2026-09-24T10:00:00.000Z"), event("same", "2026-09-24T10:00:00.000Z")];
    expect(pageAuditEvents(twins, { limit: 10 }).events).toHaveLength(2);
  });
});

describe("cursor, limit and pattern helpers", () => {
  test("a cursor round-trips and a foreign one is refused", () => {
    expect(decodeCursor(encodeCursor({ timestamp: "t", id: "i" }))).toEqual({ ts: "t", id: "i" });
    expect(() => decodeCursor("%%%")).toThrow("Invalid audit cursor");
  });

  test("the limit is clamped into 1..MAX", () => {
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10.7)).toBe(10);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampLimit(MAX_AUDIT_PAGE_SIZE + 1)).toBe(MAX_AUDIT_PAGE_SIZE);
  });

  test("a contains-pattern escapes LIKE metacharacters and lower-cases", () => {
    expect(containsPattern("A_b%c\\d")).toBe("%a\\_b\\%c\\\\d%");
  });
});
