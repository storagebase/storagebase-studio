import "../../../setup-dom";

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import type { ResourceConnection, ResourceConnectionRow } from "@/storagebase/resources/types";
import {
  resourceConnectionInputOf,
  useResourceConnections,
} from "@/components/storagebase/sections/use-resource-connections";
import { useManagedResourceConnections } from "@/components/storagebase/sections/use-managed-resource-connections";
import { useResourceHealth } from "@/components/storagebase/sections/use-resource-health";
import { useResourceSection } from "@/components/storagebase/sections/use-resource-section";
import {
  useResourceConnectionForm,
  type TestOutcome,
} from "@/components/storagebase/sections/use-resource-connection-form";
import { registerResourceProviderLoader } from "@/storagebase/resources/registry";

const stored: ResourceConnectionRow = {
  id: "res_k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker:9092",
  hasCredential: true,
};
const seeded: ResourceConnectionRow = {
  id: "seed:v1",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  seeded: true,
  permission: "read",
  hasCredential: true,
};

function catalog(connections: ResourceConnectionRow[] = [stored, seeded]) {
  return { json: { connections, storeAvailable: true } };
}

/** The fetch mock's Request carries the body; the call's init carries it too (for assertions). */
async function requestBody(req: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(await (req as Request).text()) as Record<string, unknown>;
}
function bodyOf(call: unknown): Record<string, unknown> {
  const init = (call as unknown[])[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}
function urlOf(call: unknown): string {
  return String((call as unknown[])[0]);
}
function fetchMock(): ReturnType<typeof mock> {
  return globalThis.fetch as unknown as ReturnType<typeof mock>;
}

describe("section hooks against the fork connection catalog", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/messaging");
    localStorage.clear();
    mockGlobalFetch({ "/api/sb/resources/connections": catalog() });
  });
  afterEach(() => {
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("useResourceConnections reads the catalog once, with the store flag and no credential", async () => {
    const { result } = renderHook(() => useResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([stored, seeded]);
    expect(result.current.storeAvailable).toBe(true);
    expect(result.current.error).toBeNull();
    expect(JSON.stringify(result.current.connections)).not.toContain("secretAccessKey");
  });

  test("a failed or malformed catalog read keeps an honest error and no rows", async () => {
    mockGlobalFetch({ "/api/sb/resources/connections": { status: 500, json: { error: "down" } } });
    const failed = renderHook(() => useResourceConnections());
    await waitFor(() => expect(failed.result.current.error).toBe("down"));
    expect(failed.result.current.connections).toEqual([]);
    failed.unmount();
    restoreGlobalFetch();

    mockGlobalFetch({ "/api/sb/resources/connections": { json: { nope: true } } });
    const malformed = renderHook(() => useResourceConnections());
    await waitFor(() => expect(malformed.result.current.error).toBe("Connection list answer was malformed"));
  });

  test("a disabled hook never reads, and a reload asks again", async () => {
    const disabled = renderHook(() => useResourceConnections(false));
    await act(async () => {});
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(disabled.result.current.loading).toBe(false);
    expect(disabled.result.current.connections).toEqual([]);
    disabled.unmount();

    const enabled = renderHook(() => useResourceConnections());
    await waitFor(() => expect(enabled.result.current.loading).toBe(false));
    const before = fetchMock().mock.calls.length;
    act(() => enabled.result.current.reload());
    await waitFor(() => expect(fetchMock().mock.calls.length).toBeGreaterThan(before));
  });

  test("save creates a stored row by posting a whitelisted body, then reloads", async () => {
    const created: ResourceConnectionRow = { ...stored, id: "res_created", name: "new" };
    mockGlobalFetch({
      "/api/sb/resources/connections": async (req) =>
        (await requestBody(req)).action === "list" ? catalog() : { json: { connection: created } },
    });
    const { result } = renderHook(() => useResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const writes: ResourceConnectionRow[] = [];
    await act(async () => {
      writes.push(
        await result.current.save({ id: "local1", name: "new", type: "kafka", endpoint: "broker:9092" } as never),
      );
    });
    expect(writes[0]).toEqual(created);
    const createCall = fetchMock().mock.calls.find((call) => bodyOf(call).action === "create");
    expect(bodyOf(createCall)).toMatchObject({
      action: "create",
      connection: { name: "new", type: "kafka", endpoint: "broker:9092" },
    });
    await waitFor(() => expect(fetchMock().mock.calls.filter((call) => bodyOf(call).action === "list").length).toBe(2));
  });

  test("save updates a stored row by id; a seeded row is refused before any write", async () => {
    mockGlobalFetch({
      "/api/sb/resources/connections": async (req) =>
        (await requestBody(req)).action === "list" ? catalog() : { json: { connection: stored } },
    });
    const { result } = renderHook(() => useResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save({ ...stored, name: "renamed" });
    });
    const update = fetchMock().mock.calls.find((call) => urlOf(call).includes("/res_k1"));
    expect(urlOf(update)).toContain("/api/sb/resources/connections/res_k1");
    expect(bodyOf(update)).toMatchObject({ action: "update", connection: { name: "renamed" } });
    let refused = "";
    try {
      await result.current.save(seeded);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toBe("Preconfigured connections are read-only");
  });

  test("delete removes a stored row by id; a seeded id is refused", async () => {
    mockGlobalFetch({
      "/api/sb/resources/connections": async (req) =>
        (await requestBody(req)).action === "list" ? catalog() : { json: { deleted: true } },
    });
    const { result } = renderHook(() => useResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.deleteResourceConnection("res_k1");
    });
    const deletion = fetchMock().mock.calls.find((call) => bodyOf(call).action === "delete");
    expect(urlOf(deletion)).toContain("/api/sb/resources/connections/res_k1");
    let refused = "";
    try {
      await result.current.deleteResourceConnection("seed:v1");
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toBe("Preconfigured connections are read-only");
  });

  test("resourceConnectionInputOf carries only named string fields", () => {
    expect(resourceConnectionInputOf({ ...stored, region: "eu", secretAccessKey: "secret" } as never)).toMatchObject({
      name: "events",
      type: "kafka",
      endpoint: "broker:9092",
      region: "eu",
      secretAccessKey: "secret",
    });
  });

  test("useManagedResourceConnections keeps only seeded rows, with its own loading and error", async () => {
    const { result } = renderHook(() => useManagedResourceConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([seeded]);
    expect(result.current.error).toBeNull();
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  test("a managed read failure keeps an empty list and says why", async () => {
    mockGlobalFetch({ "/api/sb/resources/connections": { status: 403, json: { error: "no" } } });
    const { result } = renderHook(() => useManagedResourceConnections());
    await waitFor(() => expect(result.current.error).toBe("Managed connections could not be loaded"));
    expect(result.current.connections).toEqual([]);
  });

  test("useResourceHealth probes by id, holds 'checking' until the answer, and reports refusals", async () => {
    mockGlobalFetch({ "/api/sb/resources/health": { json: { status: "healthy" } } });
    const { result, rerender } = renderHook(({ conn }) => useResourceHealth(conn), {
      initialProps: { conn: stored as typeof stored | null },
    });
    expect(result.current).toEqual({ status: "checking" });
    await waitFor(() => expect(result.current).toEqual({ status: "healthy" }));
    const probe = fetchMock().mock.calls.find((call) => urlOf(call).includes("health"));
    expect(bodyOf(probe)).toEqual({ connectionId: "res_k1" });
    rerender({ conn: { ...stored, id: "res_other" } });
    expect(result.current).toEqual({ status: "checking" });
    rerender({ conn: null });
    expect(result.current).toBeNull();

    restoreGlobalFetch();
    mockGlobalFetch({ "/api/sb/resources/health": { status: 503, json: { error: "unreachable" } } });
    const refused = renderHook(() => useResourceHealth(stored));
    await waitFor(() => expect(refused.result.current).toEqual({ status: "error", message: "unreachable" }));
    refused.unmount();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/sb/resources/health": { status: 503, text: "not json" } });
    const fallback = renderHook(() => useResourceHealth(stored));
    await waitFor(() =>
      expect(fallback.result.current).toEqual({ status: "error", message: "Health check failed (503)" }),
    );
    fallback.unmount();
    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/sb/resources/health": () => {
        throw new Error("offline");
      },
    });
    const thrown = renderHook(() => useResourceHealth(stored));
    await waitFor(() => expect(thrown.result.current).toEqual({ status: "error", message: "offline" }));
  });

  test("useResourceSection filters by category, remembers the pick, and derives the active row", async () => {
    const vault: ResourceConnectionRow = { ...seeded, id: "res_v1", name: "keys", seeded: undefined };
    const seededKafka: ResourceConnectionRow = { ...seeded, id: "seed:k1", type: "kafka", name: "shared events" };
    mockGlobalFetch({ "/api/sb/resources/connections": catalog([stored, seededKafka, vault]) });
    const { result } = renderHook(() => useResourceSection("messaging", "seed:k1"));
    await waitFor(() => expect(result.current.connections.map((conn) => conn.id)).toEqual(["res_k1", "seed:k1"]));
    expect(result.current.active?.id).toBe("seed:k1");
    expect(result.current.managedError).toBeNull();
    act(() => result.current.select(stored));
    expect(result.current.active?.id).toBe("res_k1");
    expect(localStorage.getItem("storagebase.section.messaging.connection")).toBe("res_k1");
    expect(new URL(window.location.href).searchParams.get("connection")).toBe("res_k1");
    // A remembered pick from another section cannot leak into this one.
    const other = renderHook(() => useResourceSection("vault"));
    await waitFor(() => expect(other.result.current.active?.id).toBe("res_v1"));
    other.unmount();
  });

  test("a storage that throws neither remembers nor reads a pick", async () => {
    const original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      clear: () => {},
    } as unknown as Storage;
    try {
      const { result } = renderHook(() => useResourceSection("messaging"));
      await waitFor(() => expect(result.current.active?.id).toBe("res_k1"));
      act(() => result.current.select(stored));
      expect(result.current.active?.id).toBe("res_k1");
    } finally {
      globalThis.localStorage = original;
    }
  });

  test("the form probes once, saves on the second degraded click, and clears its fields", async () => {
    const verdict: TestOutcome = { success: true, degraded: true, message: "No health surface.", latencyMs: 12 };
    mockGlobalFetch({
      "/api/sb/resources/test": () => ({ json: verdict }),
      "/api/sb/resources/connections": async (req) =>
        (await requestBody(req)).action === "list" ? catalog() : { json: { connection: stored } },
    });
    const onConnect = mock(async (_conn: unknown) => {});
    const held: { form: ReturnType<typeof useResourceConnectionForm> | null } = { form: null };
    function Harness() {
      held.form = useResourceConnectionForm({ category: "messaging", isOpen: true, onClose: () => {}, onConnect });
      if (held.form.type !== "kafka") held.form.setType("kafka");
      return <span data-testid="verdict">{held.form.testResult?.message}</span>;
    }
    render(<Harness />);
    await act(async () => {
      held.form?.setFieldValue("endpoint", "broker2:9092");
      await held.form?.handleTestConnection();
    });
    expect(screen.getByTestId("verdict").textContent).toContain("No health surface.");
    await act(async () => {
      await held.form?.handleConnect();
    });
    expect(onConnect).not.toHaveBeenCalled();
    await act(async () => {
      await held.form?.handleConnect();
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect((onConnect.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "kafka", endpoint: "broker2:9092" });
    expect(screen.getByTestId("verdict").textContent).toBe("");
    expect(held.form?.fieldValues.endpoint).toBe("");
    expect(held.form?.takesField("endpoint")).toBe(true);
    expect(Array.isArray(held.form?.selectableTypes("vault"))).toBe(true);
    act(() => held.form?.setTestResult({ tone: "success", message: "manual" }));
    expect(screen.getByTestId("verdict").textContent).toBe("manual");
  });

  test("the form reports a plain failure, a network error, a save refusal and a seeded refusal", async () => {
    let answer: Record<string, unknown> = { success: false, message: "refused" };
    mockGlobalFetch({ "/api/sb/resources/test": () => ({ json: answer }) });
    const held: { form: ReturnType<typeof useResourceConnectionForm> | null } = { form: null };
    function Harness({ onConnect }: { onConnect: (conn: ResourceConnection) => Promise<unknown> }) {
      held.form = useResourceConnectionForm({ isOpen: true, onClose: () => {}, onConnect });
      return <span data-testid="verdict">{held.form.testResult?.message}</span>;
    }
    const view = render(<Harness onConnect={async () => {}} />);
    await act(async () => {
      await held.form?.handleConnect();
    });
    expect(view.getByTestId("verdict").textContent).toBe("refused");
    answer = { success: true, message: "" };
    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/sb/resources/test": () => {
        throw new Error("offline");
      },
    });
    await act(async () => {
      await held.form?.handleTestConnection();
    });
    expect(view.getByTestId("verdict").textContent).toBe("Network error - could not reach server");
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/sb/resources/test": () => ({ json: answer }) });
    view.unmount();
    const refusal = mock(async () => {
      throw new Error("not allowed");
    });
    const second = render(<Harness onConnect={refusal} />);
    await act(async () => {
      await held.form?.handleConnect();
    });
    expect(second.getByTestId("verdict").textContent).toBe("not allowed");
    second.unmount();

    // A seeded row reaches the form only through a programming mistake: refuse, never write.
    const seededForm = render(
      <Harness
        onConnect={async () => {
          throw new Error("unreachable");
        }}
      />,
    );
    await act(async () => {
      held.form?.setType("azure-key-vault");
    });
    expect(seededForm.getByTestId("verdict").textContent).not.toBe("unreachable");
  });

  test("the form honours the test adapter, edit population, category correction and close reset", async () => {
    const onTest = mock(
      async (_conn: ResourceConnection): Promise<TestOutcome> => ({ success: true, message: "adapter" }),
    );
    const onConnect = mock(async (_conn: ResourceConnection) => {});
    const edit: ResourceConnection = {
      ...stored,
      type: "azure-key-vault",
      name: "renamed vault",
      endpoint: "https://vault",
      tenantId: "tenant",
    };
    const held: { form: ReturnType<typeof useResourceConnectionForm> | null } = { form: null };
    function Harness({ isOpen, editing }: { isOpen: boolean; editing: ResourceConnection | null }) {
      held.form = useResourceConnectionForm({
        category: "vault",
        isOpen,
        onClose: () => {},
        onConnect,
        editConnection: editing,
        onTestConnection: onTest,
      });
      return <span data-testid="type">{held.form.type}</span>;
    }
    const view = render(<Harness isOpen editing={edit} />);
    expect(screen.getByTestId("type").textContent).toBe("azure-key-vault");
    expect(held.form?.name).toBe("renamed vault");
    expect(held.form?.fieldValues.tenantId).toBe("tenant");
    await act(async () => {
      await held.form?.handleTestConnection();
    });
    expect(onTest).toHaveBeenCalledTimes(1);
    // Switching the category moves an out-of-family type to the first selectable one.
    const switched = render(<Harness isOpen editing={null} />);
    await waitFor(() => expect(held.form?.type).not.toBe("azure-key-vault"));
    switched.unmount();
    // Closing without an edit resets the typed values.
    act(() => {
      held.form?.setName("typed");
    });
    view.rerender(<Harness isOpen={false} editing={null} />);
    expect(held.form?.name).toBe("");
  });

  test("the form moves an out-of-category type to the first selectable one", async () => {
    registerResourceProviderLoader("azure-key-vault", async () => {
      throw new Error("not loaded");
    });
    registerResourceProviderLoader("kafka", async () => {
      throw new Error("not loaded");
    });
    const held: { form: ReturnType<typeof useResourceConnectionForm> | null } = { form: null };
    function Harness({ category }: { category: "vault" | "messaging" }) {
      held.form = useResourceConnectionForm({ category, isOpen: true, onClose: () => {}, onConnect: async () => {} });
      return <span data-testid="type">{held.form.type}</span>;
    }
    const view = render(<Harness category="vault" />);
    expect(screen.getByTestId("type").textContent).toBe("azure-key-vault");
    view.rerender(<Harness category="messaging" />);
    await waitFor(() => expect(held.form?.type).toBe("kafka"));
  });

  test("fireEvent still drives a form input end to end", () => {
    function Harness() {
      const form = useResourceConnectionForm({ isOpen: true, onClose: () => {}, onConnect: async () => {} });
      return (
        <input
          aria-label="name"
          value={form.name}
          onChange={(event) => form.setName(event.target.value)}
          data-testid="name"
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByTestId("name"), { target: { value: "typed" } });
    expect(screen.getByTestId("name").getAttribute("value")).toBe("typed");
  });
});
