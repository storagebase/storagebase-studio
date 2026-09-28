import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ManagedResourceConnection, ResourceConnection } from "@/lib/resources/types";

// The managed source is a seam the entra work fills; here it is whatever each test says.
let managedState: { connections: ManagedResourceConnection[]; loading: boolean; error: string | null } = {
  connections: [],
  loading: false,
  error: null,
};
mock.module("@/hooks/use-managed-resource-connections", () => ({
  useManagedResourceConnections: () => managedState,
}));

const { useResourceSection } = await import("@/hooks/use-resource-section");
const { storage } = await import("@/lib/storage");

const kafka: ResourceConnection = { id: "k1", name: "events", type: "kafka", createdAt: "2026-01-01T00:00:00.000Z" };
const rabbit: ResourceConnection = {
  id: "r1",
  name: "orders",
  type: "rabbitmq",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const bucket: ResourceConnection = { id: "s1", name: "backups", type: "s3", createdAt: "2026-01-01T00:00:00.000Z" };
const managedSqs: ManagedResourceConnection = {
  id: "m1",
  name: "shared queue",
  type: "sqs",
  createdAt: "2026-01-01T00:00:00.000Z",
  managed: true,
  permission: "read",
};

const KEY = "storagebase.section.messaging.connection";

describe("useResourceSection", () => {
  beforeEach(() => {
    localStorage.clear();
    managedState = { connections: [], loading: false, error: null };
    window.history.replaceState(null, "", "/messaging");
    storage.saveResourceConnection(kafka);
    storage.saveResourceConnection(bucket);
    storage.saveResourceConnection(rabbit);
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("lists only this category's own connections, then the managed ones, once each", () => {
    managedState = {
      connections: [
        managedSqs,
        { ...managedSqs, id: "m2", type: "s3" },
        // An id the viewer also owns is theirs: listed once, as their own.
        { ...managedSqs, id: "k1", type: "kafka" },
      ],
      loading: true,
      error: "boom",
    };
    const { result } = renderHook(() => useResourceSection("messaging", true));
    expect(result.current.connections.map((c) => c.id)).toEqual(["k1", "r1", "m1"]);
    expect(result.current.connections[0].name).toBe("events");
    expect("managed" in result.current.connections[0]).toBe(false);
    expect(result.current.managedLoading).toBe(true);
    expect(result.current.managedError).toBe("boom");
  });

  test("nothing is listed or active until storage is ready; then the first activates", () => {
    const { result, rerender } = renderHook(({ ready }) => useResourceSection("messaging", ready), {
      initialProps: { ready: false },
    });
    expect(result.current.connections).toEqual([]);
    expect(result.current.active).toBeNull();
    rerender({ ready: true });
    expect(result.current.active?.id).toBe("k1");
  });

  test("the deep link wins over the remembered connection, which wins over the first", () => {
    localStorage.setItem(KEY, "r1");
    expect(renderHook(() => useResourceSection("messaging", true, "k1")).result.current.active?.id).toBe("k1");
    expect(renderHook(() => useResourceSection("messaging", true)).result.current.active?.id).toBe("r1");
    // A deep link to a connection this section does not list falls through to the remembered one.
    expect(renderHook(() => useResourceSection("messaging", true, "s1")).result.current.active?.id).toBe("r1");
  });

  test("selecting remembers the pick per section and writes it into the address bar", () => {
    const { result } = renderHook(() => useResourceSection("messaging", true));
    act(() => result.current.select(rabbit));
    expect(result.current.active?.id).toBe("r1");
    expect(localStorage.getItem(KEY)).toBe("r1");
    expect(new URL(window.location.href).searchParams.get("connection")).toBe("r1");
    expect(window.location.pathname).toBe("/messaging");
    // Another section's memory is its own.
    expect(localStorage.getItem("storagebase.section.blob.connection")).toBeNull();
  });

  test("saving persists and makes the saved connection active", () => {
    const { result } = renderHook(() => useResourceSection("messaging", true));
    const sqs: ResourceConnection = { id: "q1", name: "jobs", type: "sqs", createdAt: "2026-01-01T00:00:00.000Z" };
    act(() => result.current.save(sqs));
    expect(storage.getResourceConnections().some((c) => c.id === "q1")).toBe(true);
    expect(result.current.active?.id).toBe("q1");
  });

  test("removing the active connection falls back to the first survivor, never to a ghost", () => {
    const { result } = renderHook(() => useResourceSection("messaging", true));
    act(() => result.current.select(rabbit));
    act(() => result.current.remove("r1"));
    expect(result.current.connections.map((c) => c.id)).toEqual(["k1"]);
    expect(result.current.active?.id).toBe("k1");
    act(() => result.current.remove("k1"));
    expect(result.current.active).toBeNull();
  });

  test("storage the browser refuses remembers nothing and breaks nothing", () => {
    // Refused for the section's own keys only: the connection store shares the same storage.
    const getItem = localStorage.getItem.bind(localStorage);
    const setItem = localStorage.setItem.bind(localStorage);
    const get = spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      if (key.startsWith("storagebase.section.")) throw new Error("SecurityError");
      return getItem(key);
    });
    const set = spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key.startsWith("storagebase.section.")) throw new Error("QuotaExceededError");
      setItem(key, value);
    });
    try {
      const { result } = renderHook(() => useResourceSection("messaging", true));
      act(() => result.current.select(rabbit));
      expect(result.current.active?.id).toBe("r1");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
