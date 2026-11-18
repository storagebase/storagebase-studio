import "../../../setup-dom";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { registerResourceViewer } from "@/components/storagebase/resources/viewer-registry";
import { registerResourceProviderLoader } from "@/storagebase/resources/registry";

// Radix Select needs a real pointer stack; this shell keeps the form's own
// lines under test (the picker behaviour belongs to the UI primitive).
mock.module("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>selected</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("@/components/storagebase/resources/kafka/KafkaWorkbench", () => ({
  KafkaWorkbench: ({ connection, readOnly }: { connection: { id: string }; readOnly?: boolean }) => (
    <div data-testid="kafka-workbench" data-id={connection.id} data-readonly={readOnly === true ? "true" : "false"} />
  ),
}));
import { sectionConnectionBody } from "@/components/storagebase/sections/connection-body";
import { ResourceConnectionForm } from "@/components/storagebase/sections/ResourceConnectionForm";
import { ResourceTree } from "@/components/storagebase/sections/ResourceTree";
import { ResourceViewerPane } from "@/components/storagebase/sections/ResourceViewerPane";
import { SectionKafkaWorkbench } from "@/components/storagebase/sections/SectionKafkaWorkbench";
import type { ResourceConnectionRow, ResourceNode } from "@/storagebase/resources/types";

const stored: ResourceConnectionRow = {
  id: "res_k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasCredential: true,
};
const seeded: ResourceConnectionRow = {
  ...stored,
  id: "seed:k1",
  seeded: true,
  permission: "read",
};
const container: ResourceNode = {
  id: "root/folder",
  parentId: null,
  kind: "container",
  name: "folder",
  hasChildren: true,
  meta: { count: 3 },
};
const leaf: ResourceNode = { id: "root/jobs", parentId: null, kind: "object", name: "jobs", hasChildren: false };

function requestBody(req: unknown): Promise<Record<string, unknown>> {
  return (req as Request).json() as Promise<Record<string, unknown>>;
}
function bodyOfCall(call: unknown): Record<string, unknown> {
  return JSON.parse(((call as unknown[])[1] as { body: string }).body) as Record<string, unknown>;
}

describe("section adapters over the fork API", () => {
  beforeEach(() => {
    mockGlobalFetch({ "/api/sb/resources/tree": { json: { nodes: [], truncated: false } } });
  });
  afterEach(() => restoreGlobalFetch());

  test("sectionConnectionBody names stored and seeded rows by id, but inlines a form candidate", () => {
    expect(sectionConnectionBody(stored)).toEqual({ connectionId: "res_k1" });
    expect(sectionConnectionBody(seeded)).toEqual({ connectionId: "seed:k1" });
    expect(sectionConnectionBody({ ...stored, id: "local1" })).toEqual({ connection: { ...stored, id: "local1" } });
  });

  test("the tree lists a bounded level, expands a container, and refreshes answered levels", async () => {
    let calls = 0;
    mockGlobalFetch({
      "/api/sb/resources/tree": async (req) => {
        const body = await requestBody(req);
        calls += 1;
        if (body.parent === undefined) {
          return { json: { nodes: [container, leaf], truncated: true } };
        }
        return { json: { nodes: [{ ...leaf, id: "root/folder/child", name: "child" }], truncated: false } };
      },
    });
    const click = mock((_node: ResourceNode) => {});
    const view = render(<ResourceTree connection={stored} onNodeClick={click} refreshToken={0} />);
    expect(screen.getByTestId("resource-tree-loading")).toBeDefined();
    await waitFor(() => expect(screen.getByText("folder")).toBeDefined());
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("List truncated by the provider.")).toBeDefined();
    const probe = bodyOfCall((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]);
    expect(probe).toEqual({ connectionId: "res_k1" });

    fireEvent.click(screen.getByText("folder"));
    expect(click).toHaveBeenCalledWith(container);
    await waitFor(() => expect(screen.getByText("child")).toBeDefined());
    // Collapsing hides the child; a refresh re-reads the level and keeps expansion.
    fireEvent.click(screen.getByText("folder"));
    expect(screen.queryByText("child")).toBeNull();
    fireEvent.click(screen.getByText("folder"));
    await waitFor(() => expect(screen.getByText("child")).toBeDefined());
    const before = calls;
    view.rerender(<ResourceTree connection={stored} onNodeClick={click} refreshToken={1} />);
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    expect(screen.getByText("child")).toBeDefined();
  });

  test("the tree reports an unreadable level and retries, and says when a level is empty", async () => {
    let fail = true;
    mockGlobalFetch({
      "/api/sb/resources/tree": () =>
        fail ? { status: 500, json: { error: "refused" } } : { json: { nodes: [], truncated: false } },
    });
    render(<ResourceTree connection={stored} />);
    await waitFor(() => expect(screen.getByTestId("resource-tree-error")).toBeDefined());
    expect(screen.getByText("refused")).toBeDefined();
    // A retry that also fails keeps the refusal on screen (the loadLevel catch).
    fireEvent.click(screen.getByTestId("resource-tree-retry"));
    await waitFor(() => expect(screen.getByText("refused")).toBeDefined());
    fail = false;
    fireEvent.click(screen.getByTestId("resource-tree-retry"));
    await waitFor(() => expect(screen.getByTestId("resource-tree-empty")).toBeDefined());
  });

  test("the viewer pane resolves a registered family viewer through the registry", () => {
    registerResourceViewer("azure-key-vault", ({ connection, node }: { connection: unknown; node: ResourceNode }) => (
      <div data-testid="fake-viewer">
        {String((connection as ResourceConnectionRow).id)}:{node.id}
      </div>
    ));
    render(
      <ResourceViewerPane
        connection={{ ...stored, type: "azure-key-vault" }}
        node={leaf}
        readOnly
        onChanged={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("fake-viewer").textContent).toBe("res_k1:root/jobs");
    // A tree-browsed type with no registered viewer fails loudly, not silently.
    expect(() =>
      render(
        <ResourceViewerPane
          connection={{ ...stored, type: "kafka" }}
          node={leaf}
          readOnly={false}
          onChanged={() => {}}
          onClose={() => {}}
        />,
      ),
    ).toThrow();
  });

  test("the messaging workbench forwards its connection and read-only grant to the Kafka workbench", () => {
    const view = render(<SectionKafkaWorkbench connection={stored} readOnly />);
    const workbench = screen.getByTestId("kafka-workbench");
    expect(workbench.getAttribute("data-id")).toBe("res_k1");
    expect(workbench.getAttribute("data-readonly")).toBe("true");

    view.rerender(<SectionKafkaWorkbench connection={seeded} />);
    expect(screen.getByTestId("kafka-workbench").getAttribute("data-id")).toBe("seed:k1");
    expect(screen.getByTestId("kafka-workbench").getAttribute("data-readonly")).toBe("false");
  });

  test("the connection form renders the family's fields and probes before it saves", async () => {
    registerResourceProviderLoader("azure-blob", async () => {
      throw new Error("not loaded");
    });
    let verdict = { success: true, message: "ok" };
    mockGlobalFetch({ "/api/sb/resources/test": () => ({ json: verdict }) });
    const onConnect = mock(async (_conn: unknown) => {});
    render(
      <ResourceConnectionForm category="blob" isOpen onClose={() => {}} onConnect={onConnect} editConnection={null} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "backups" } });
    fireEvent.change(screen.getByLabelText("endpoint"), { target: { value: "https://blob" } });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Connected successfully"));
    verdict = { success: false, message: "refused" };
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("refused"));
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Name").closest("form") as HTMLFormElement);
    });
    expect(onConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The close is reported, not performed by the form.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });
});
