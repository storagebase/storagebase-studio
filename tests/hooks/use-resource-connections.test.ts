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

  test("starts empty until storage is ready, then loads every category", () => {
    storage.saveResourceConnection(s3);
    storage.saveResourceConnection(kafka);

    const { result, rerender } = renderHook(({ ready }: { ready: boolean }) => useResourceConnections(ready), {
      initialProps: { ready: false },
    });

    expect(result.current.connections).toEqual([]);

    rerender({ ready: true });

    expect(result.current.connections.map((c) => c.id)).toEqual(["res-1", "res-2"]);
  });

  test("save persists and refreshes the list, in place for an existing id", () => {
    const { result } = renderHook(() => useResourceConnections(true));

    act(() => {
      result.current.saveResourceConnection(kafka);
    });

    expect(storage.getResourceConnections().map((c) => c.id)).toEqual(["res-2"]);
    expect(result.current.connections.map((c) => c.id)).toEqual(["res-2"]);

    act(() => {
      result.current.saveResourceConnection({ ...kafka, name: "renamed" });
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].name).toBe("renamed");
  });

  test("delete removes from storage and the list", () => {
    storage.saveResourceConnection(s3);
    storage.saveResourceConnection(kafka);
    const { result } = renderHook(() => useResourceConnections(true));

    act(() => {
      result.current.deleteResourceConnection("res-1");
    });

    expect(result.current.connections.map((c) => c.id)).toEqual(["res-2"]);
    expect(storage.getResourceConnections().map((c) => c.id)).toEqual(["res-2"]);
  });
});
