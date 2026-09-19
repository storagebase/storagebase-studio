import { describe, test, expect, beforeEach } from "bun:test";

// Ensure `typeof window !== 'undefined'` passes in the facade's guards
if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub for SSR guard
  globalThis.window = globalThis;
}

import { storage } from "@/lib/storage/storage-facade";
import type { ResourceConnection } from "@/lib/resources/types";

const connection = (id: string, name = "Test"): ResourceConnection => ({
  id,
  name,
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("storage facade over resource_connections", () => {
  beforeEach(() => {
    for (const existing of storage.getResourceConnections()) storage.deleteResourceConnection(existing.id);
  });

  test("an empty store reads as an empty list", () => {
    expect(storage.getResourceConnections()).toEqual([]);
  });

  test("save appends and overwrites by id without touching database connections", () => {
    storage.saveResourceConnection(connection("res-1", "One"));
    storage.saveResourceConnection(connection("res-2", "Two"));
    storage.saveResourceConnection(connection("res-1", "One renamed"));
    const saved = storage.getResourceConnections();
    expect(saved.map((c) => c.name).sort()).toEqual(["One renamed", "Two"]);
    // A sibling store, never a shared one.
    expect(storage.getConnections()).toEqual([]);
  });

  test("delete removes only the named id", () => {
    storage.saveResourceConnection(connection("res-1"));
    storage.saveResourceConnection(connection("res-2"));
    storage.deleteResourceConnection("res-1");
    expect(storage.getResourceConnections().map((c) => c.id)).toEqual(["res-2"]);
    storage.deleteResourceConnection("res-2");
    expect(storage.getResourceConnections()).toEqual([]);
  });
});
