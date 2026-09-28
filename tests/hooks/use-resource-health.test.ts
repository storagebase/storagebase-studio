import "../setup-dom";

import { describe, test, expect, afterEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { useResourceHealth } from "@/hooks/use-resource-health";
import type { ResourceConnection } from "@/lib/resources/types";

const kafka: ResourceConnection = { id: "k1", name: "events", type: "kafka", createdAt: "2026-01-01T00:00:00.000Z" };
const vault: ResourceConnection = { id: "v1", name: "keys", type: "openbao", createdAt: "2026-01-01T00:00:00.000Z" };

describe("useResourceHealth", () => {
  afterEach(() => restoreGlobalFetch());

  test("no connection, no probe", () => {
    const fetchMock = mockGlobalFetch({});
    const { result } = renderHook(() => useResourceHealth(null));
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("checks, then answers the probe, posting the connection body", async () => {
    const fetchMock = mockGlobalFetch({
      "api/resources/health": { json: { status: "healthy", latencyMs: 4 } },
    });
    const { result } = renderHook(() => useResourceHealth(kafka));
    expect(result.current).toEqual({ status: "checking" });
    await waitFor(() => expect(result.current).toEqual({ status: "healthy", latencyMs: 4 }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ connection: kafka });
  });

  test("a new connection shows checking at once, never the previous one's answer", async () => {
    mockGlobalFetch({ "api/resources/health": { json: { status: "degraded", message: "slow" } } });
    const { result, rerender } = renderHook(({ conn }) => useResourceHealth(conn), { initialProps: { conn: kafka } });
    await waitFor(() => expect(result.current?.status).toBe("degraded"));
    rerender({ conn: vault });
    expect(result.current).toEqual({ status: "checking" });
    await waitFor(() => expect(result.current?.status).toBe("degraded"));
  });

  test("a refused probe is an error carrying the server's sentence", async () => {
    mockGlobalFetch({ "api/resources/health": { status: 400, json: { error: "A resource connection is required" } } });
    const { result } = renderHook(() => useResourceHealth(kafka));
    await waitFor(() =>
      expect(result.current).toEqual({ status: "error", message: "A resource connection is required" }),
    );
  });

  test("a refusal without a body, and a network failure, still answer an error", async () => {
    mockGlobalFetch({ "api/resources/health": { status: 502, text: "" } });
    const first = renderHook(() => useResourceHealth(kafka));
    await waitFor(() =>
      expect(first.result.current).toEqual({ status: "error", message: "Health check failed (502)" }),
    );

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const second = renderHook(() => useResourceHealth(vault));
    await waitFor(() => expect(second.result.current).toEqual({ status: "error", message: "offline" }));

    globalThis.fetch = (async () => {
      throw "plain";
    }) as unknown as typeof fetch;
    // Held in a const: the hook probes per connection OBJECT, so a fresh literal per render would never settle.
    const other = { ...vault, id: "v2" };
    const third = renderHook(() => useResourceHealth(other));
    await waitFor(() => expect(third.result.current).toEqual({ status: "error", message: "plain" }));
  });

  test("an answer that lands after unmount is dropped", async () => {
    let release: (value: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((resolve) => (release = resolve))) as unknown as typeof fetch;
    const { result, unmount } = renderHook(() => useResourceHealth(kafka));
    unmount();
    release(new Response(JSON.stringify({ status: "healthy" }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toEqual({ status: "checking" });
  });
});
