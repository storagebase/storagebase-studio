import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import { useResourceConnections } from "@/hooks/use-resource-connections";
import { storage } from "@/lib/storage";
import type { ResourceConnection } from "@/lib/resources/types";

const s3: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const kafka: ResourceConnection = {
  id: "res-2",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("useResourceConnections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("starts empty until storage is ready, then loads and activates the first", () => {
    storage.saveResourceConnection(s3);
    storage.saveResourceConnection(kafka);

    const { result, rerender } = renderHook(({ ready }: { ready: boolean }) => useResourceConnections(ready), {
      initialProps: { ready: false },
    });

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();

    rerender({ ready: true });

    expect(result.current.connections.map((c) => c.id)).toEqual(["res-1", "res-2"]);
    expect(result.current.activeConnection?.id).toBe("res-1");
  });

  test("save persists, refreshes the list and activates", () => {
    const { result } = renderHook(() => useResourceConnections(true));

    act(() => {
      result.current.saveResourceConnection(kafka);
    });

    expect(storage.getResourceConnections().map((c) => c.id)).toEqual(["res-2"]);
    expect(result.current.activeConnection?.id).toBe("res-2");

    act(() => {
      result.current.saveResourceConnection({ ...kafka, name: "renamed" });
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].name).toBe("renamed");
  });

  test("deleting the active connection falls back to the first survivor", () => {
    storage.saveResourceConnection(s3);
    storage.saveResourceConnection(kafka);
    const { result } = renderHook(() => useResourceConnections(true));

    expect(result.current.activeConnection?.id).toBe("res-1");

    act(() => {
      result.current.deleteResourceConnection("res-1");
    });

    expect(result.current.connections.map((c) => c.id)).toEqual(["res-2"]);
    expect(result.current.activeConnection?.id).toBe("res-2");
    expect(storage.getResourceConnections().map((c) => c.id)).toEqual(["res-2"]);
  });

  test("deleting an inactive connection keeps the active one", () => {
    storage.saveResourceConnection(s3);
    storage.saveResourceConnection(kafka);
    const { result } = renderHook(() => useResourceConnections(true));

    act(() => {
      result.current.setActiveConnection(kafka);
    });
    act(() => {
      result.current.deleteResourceConnection("res-1");
    });

    expect(result.current.activeConnection?.id).toBe("res-2");
  });

  test("deleting the last connection clears the active one", () => {
    storage.saveResourceConnection(s3);
    const { result } = renderHook(() => useResourceConnections(true));

    act(() => {
      result.current.deleteResourceConnection("res-1");
    });

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();
  });
});
