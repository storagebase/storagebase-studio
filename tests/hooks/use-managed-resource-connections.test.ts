import "../setup-dom";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useManagedResourceConnections } from "@/hooks/use-managed-resource-connections";

/**
 * The managed resource list the section pages render (StorageBase fork): a fetch of
 * `GET /api/resources/managed`, a stable empty list, the last good list kept on failure.
 */

const ROW = {
  id: "managed:vault-1",
  name: "Team vault",
  type: "azure-key-vault",
  createdAt: "2026-09-01T00:00:00.000Z",
  managed: true,
  permission: "read",
  groupNames: ["Payments"],
};

let answer: () => Promise<Response>;
const fetchMock = mock(() => answer());

beforeEach(() => {
  fetchMock.mockClear();
  answer = async () => new Response(JSON.stringify({ connections: [ROW] }), { status: 200 });
  globalThis.fetch = fetchMock as never;
});

describe("useManagedResourceConnections", () => {
  test("loads the caller's managed connections", async () => {
    const { result } = renderHook(() => useManagedResourceConnections());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([ROW] as never);
    expect(result.current.error).toBeNull();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/resources/managed");
  });

  test("an empty answer is the same frozen list on every render and every read", async () => {
    answer = async () => new Response(JSON.stringify({ connections: [] }), { status: 200 });
    const { result, rerender } = renderHook(() => useManagedResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.connections;
    rerender();
    expect(result.current.connections).toBe(first);
    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toBe(first);
  });

  test("a refused read says why and keeps the last good list; a missing body reads as empty", async () => {
    const { result } = renderHook(() => useManagedResourceConnections());
    await waitFor(() => expect(result.current.connections).toHaveLength(1));
    answer = async () => new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("Authentication required"));
    expect(result.current.connections).toHaveLength(1);

    answer = async () => new Response("not json", { status: 500 });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("Managed connections could not be loaded (500)"));

    answer = async () => new Response(JSON.stringify({}), { status: 200 });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.connections).toHaveLength(0));
    expect(result.current.error).toBeNull();
  });

  test("a network failure is reported, and nothing is set after unmount", async () => {
    answer = async () => {
      throw new Error("offline");
    };
    const { result } = renderHook(() => useManagedResourceConnections());
    await waitFor(() => expect(result.current.error).toBe("Managed connections could not be loaded"));

    let release: (value: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    const second = renderHook(() => useManagedResourceConnections());
    second.unmount();
    release(new Response(JSON.stringify({ connections: [ROW] }), { status: 200 }));
    answer = async () => {
      throw new Error("offline");
    };
    const third = renderHook(() => useManagedResourceConnections());
    third.unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("disabled: no request, never loading", () => {
    const { result } = renderHook(() => useManagedResourceConnections(false));
    expect(result.current).toMatchObject({ connections: [], loading: false, error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
