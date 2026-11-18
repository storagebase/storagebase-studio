import "../../../setup-dom";
import "../../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ResourceConnection, ResourceConnectionRow, ResourceNode } from "@/storagebase/resources/types";

// ── The page's collaborators, reduced to what it hands them ────────────────
mock.module("@/storagebase/resources/providers", () => ({}));

let authState = { user: { role: "user" } as { role?: string } | null, isAdmin: false, handleLogout: mock(() => {}) };
mock.module("@/hooks/use-auth", () => ({ useAuth: () => authState }));

let mobile = false;
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));

mock.module("@/components/storagebase/sections/use-resource-health", () => ({
  useResourceHealth: (conn: unknown) => (conn ? { status: "healthy" } : null),
}));

let rows: ResourceConnectionRow[] = [];
let saved: ResourceConnectionRow | null = null;
const mockSave = mock(async (conn: ResourceConnection | ResourceConnectionRow): Promise<ResourceConnectionRow> => {
  const row: ResourceConnectionRow = {
    id: conn.id.startsWith("res_") ? conn.id : "res_saved",
    name: conn.name,
    type: conn.type,
    createdAt: conn.createdAt,
    hasCredential: false,
  };
  saved = row;
  rows = [...rows.filter((candidate) => candidate.id !== row.id), row];
  return row;
});
const mockRemove = mock(async (id: string) => {
  rows = rows.filter((candidate) => candidate.id !== id);
});
mock.module("@/components/storagebase/sections/use-resource-connections", () => ({
  useResourceConnections: () => ({
    connections: rows,
    loading: false,
    error: null,
    storeAvailable: true,
    save: mockSave,
    deleteResourceConnection: mockRemove,
    reload: () => {},
  }),
}));

let managed: ResourceConnectionRow[] = [];
mock.module("@/components/storagebase/sections/use-managed-resource-connections", () => ({
  useManagedResourceConnections: () => ({ connections: managed, loading: false, error: null, reload: () => {} }),
}));

let kafkaProps: Record<string, unknown> | null = null;
mock.module("@/components/storagebase/sections/SectionKafkaWorkbench", () => ({
  SectionKafkaWorkbench: (props: Record<string, unknown>) => {
    kafkaProps = props;
    return React.createElement("div", { "data-testid": "kafka-workbench" });
  },
}));
let vaultProps: Record<string, unknown> | null = null;
mock.module("@/components/storagebase/resources/vault", () => ({
  VaultWorkbench: (props: Record<string, unknown>) => {
    vaultProps = props;
    return React.createElement("div", { "data-testid": "vault-workbench" });
  },
}));

const bucketNode: ResourceNode = {
  id: "q/folder",
  parentId: null,
  kind: "container",
  name: "folder",
  hasChildren: true,
};
const leafNode: ResourceNode = { id: "q/jobs", parentId: null, kind: "object", name: "jobs", hasChildren: false };
let treeProps: Record<string, unknown> | null = null;
mock.module("@/components/storagebase/sections/ResourceTree", () => ({
  ResourceTree: (props: { onNodeClick: (node: ResourceNode) => void } & Record<string, unknown>) => {
    treeProps = props;
    return React.createElement(
      "div",
      { "data-testid": "resource-tree" },
      React.createElement("button", { onClick: () => props.onNodeClick(bucketNode) }, "node folder"),
      React.createElement("button", { onClick: () => props.onNodeClick(leafNode) }, "node jobs"),
    );
  },
}));
let paneProps: Record<string, unknown> | null = null;
mock.module("@/components/storagebase/sections/ResourceViewerPane", () => ({
  ResourceViewerPane: (props: { onChanged: () => void; onClose: () => void } & Record<string, unknown>) => {
    paneProps = props;
    return React.createElement(
      "div",
      { "data-testid": "viewer-pane" },
      React.createElement("button", { onClick: props.onChanged }, "viewer changed"),
      React.createElement("button", { onClick: props.onClose }, "viewer close"),
    );
  },
}));
let dialogProps: {
  isOpen: boolean;
  editConnection: ResourceConnection | null;
  category: string;
  onClose: () => void;
  onConnect: (conn: ResourceConnection) => Promise<unknown>;
} | null = null;
mock.module("@/components/storagebase/sections/ResourceConnectionDialog", () => ({
  ResourceConnectionDialog: (props: NonNullable<typeof dialogProps>) => {
    dialogProps = props;
    return null;
  },
}));
let alertOpenChange: ((open: boolean) => void) | undefined;
mock.module("@/components/ui/alert-dialog", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children);
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) => {
      alertOpenChange = onOpenChange;
      return open ? React.createElement("div", { "data-testid": "confirm-delete" }, children) : null;
    },
    AlertDialogContent: passthrough,
    AlertDialogTitle: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogCancel: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
    AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) =>
      React.createElement("button", { onClick }, children),
  };
});

const { ResourceSectionPage } = await import("@/components/storagebase/sections/ResourceSectionPage");

const kafka: ResourceConnectionRow = {
  id: "res_k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasCredential: true,
};
const blob: ResourceConnectionRow = {
  id: "res_s1",
  name: "backups",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasCredential: true,
};
const vault: ResourceConnectionRow = {
  id: "res_v1",
  name: "keys",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasCredential: true,
};
const sharedQueue: ResourceConnectionRow = {
  id: "seed:m1",
  name: "shared queue",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  seeded: true,
  permission: "read",
  hasCredential: true,
};

function rowButton(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: "span" }).closest("li") as HTMLElement;
  return within(row).getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("ResourceSectionPage", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/messaging");
    rows = [kafka, blob, vault];
    saved = null;
    mockSave.mockClear();
    mockRemove.mockClear();
    authState = { user: { role: "user" }, isAdmin: false, handleLogout: mock(() => {}) };
    mobile = false;
    managed = [];
    kafkaProps = vaultProps = treeProps = paneProps = dialogProps = null;
  });
  afterEach(() => cleanup());

  test("lists only its own family, and a Kafka connection opens the workbench under a header naming it", () => {
    managed = [sharedQueue, { ...sharedQueue, id: "seed:s3", type: "azure-blob", name: "other family" }];
    render(<ResourceSectionPage category="messaging" />);
    const listed = screen.getAllByTestId("section-connection-row").map((row) => row.getAttribute("data-connection-id"));
    expect(listed).toEqual(["res_k1", "seed:m1"]);
    expect(screen.getByRole("heading", { name: "events", level: 1 })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Messaging" })).toBeDefined();
    expect(screen.getByTestId("kafka-workbench")).toBeDefined();
    expect(kafkaProps).toMatchObject({ connection: { id: "res_k1" }, readOnly: false });
    // A workbench type draws no tree.
    expect(screen.queryByTestId("resource-tree")).toBeNull();
  });

  test("a tree type lists its tree; a leaf opens its viewer beside it, which refreshes and closes", () => {
    rows = [blob, { ...blob, id: "res_s2", name: "archive" }, vault];
    render(<ResourceSectionPage category="blob" />);
    fireEvent.click(rowButton("backups"));
    expect(screen.getByRole("heading", { name: "backups", level: 1 })).toBeDefined();
    expect(treeProps).toMatchObject({ connection: { id: "res_s1" }, refreshToken: 0 });
    expect(screen.getByText("Select an item in the tree to browse it.")).toBeDefined();

    fireEvent.click(screen.getByText("node jobs"));
    expect(paneProps).toMatchObject({ connection: { id: "res_s1" }, node: leafNode, readOnly: false });
    fireEvent.click(screen.getByText("viewer changed"));
    expect(treeProps?.refreshToken).toBe(1);
    fireEvent.click(screen.getByText("viewer close"));
    expect(screen.queryByTestId("viewer-pane")).toBeNull();

    // A container is shown too; switching connections never carries a node across.
    fireEvent.click(screen.getByText("node folder"));
    expect(paneProps?.node).toEqual(bucketNode);
    fireEvent.click(rowButton("archive"));
    fireEvent.click(rowButton("backups"));
    expect(screen.getByTestId("viewer-pane")).toBeDefined();
  });

  test("a seeded read-only connection reaches its viewer read-only and offers no edit", () => {
    managed = [{ ...sharedQueue, id: "seed:s1", type: "azure-blob", name: "shared bucket" }];
    render(<ResourceSectionPage category="blob" initialConnectionId="seed:s1" />);
    expect(screen.getByRole("heading", { name: "shared bucket", level: 1 })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
    fireEvent.click(screen.getByText("node jobs"));
    expect(paneProps?.readOnly).toBe(true);
  });

  test("a seeded Kafka connection granted read reaches the workbench read-only", () => {
    managed = [{ ...sharedQueue, id: "seed:m3", name: "shared cluster" }];
    render(<ResourceSectionPage category="messaging" initialConnectionId="seed:m3" />);
    expect(kafkaProps).toMatchObject({ connection: { id: "seed:m3" }, readOnly: true });
  });

  test("every vault opens the vault workbench, without the dropped isAdmin prop", () => {
    authState = { ...authState, isAdmin: true };
    render(<ResourceSectionPage category="vault" />);
    expect(screen.getAllByTestId("section-connection-row")).toHaveLength(1);
    expect(vaultProps).toMatchObject({ connection: { id: "res_v1" }, readOnly: false });
    expect(vaultProps?.isAdmin).toBeUndefined();
  });

  test("add, edit and duplicate open the form; a save becomes the active connection", async () => {
    render(<ResourceSectionPage category="messaging" />);
    fireEvent.click(screen.getByRole("button", { name: "Add messaging connection" }));
    expect(dialogProps).toMatchObject({ isOpen: true, editConnection: null, category: "messaging" });
    const next: ResourceConnection = {
      id: "res_q1",
      name: "jobs",
      type: "kafka",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await act(async () => {
      await dialogProps?.onConnect(next);
    });
    expect(dialogProps?.isOpen).toBe(false);
    expect(saved?.name).toBe("jobs");
    expect(screen.getByRole("heading", { name: "jobs", level: 1 })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit events" }));
    expect(dialogProps?.editConnection?.id).toBe("res_k1");
    act(() => dialogProps?.onClose());
    expect(dialogProps?.isOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Duplicate events" }));
    expect(dialogProps?.editConnection).toMatchObject({ name: "events (copy)", type: "kafka" });
    expect(dialogProps?.editConnection?.id).not.toBe("res_k1");
    expect(dialogProps?.editConnection).not.toHaveProperty("hasCredential");

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(dialogProps?.editConnection?.id).toBe("res_q1");
  });

  test("delete asks first; confirming removes, dismissing keeps", () => {
    render(<ResourceSectionPage category="messaging" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete events" }));
    expect(within(screen.getByTestId("confirm-delete")).getByText("events")).toBeDefined();
    act(() => alertOpenChange?.(true));
    expect(screen.getByTestId("confirm-delete")).toBeDefined();
    act(() => alertOpenChange?.(false));
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
    expect(rows.some((conn) => conn.id === "res_k1")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete events" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(rows.some((conn) => conn.id === "res_k1")).toBe(false);
    expect(mockRemove).toHaveBeenCalledWith("res_k1");
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
  });

  test("an empty section invites a first connection from the main area", () => {
    render(<ResourceSectionPage category="blob" initialConnectionId={null} />);
    fireEvent.click(rowButton("backups"));
    fireEvent.click(screen.getByRole("button", { name: "Delete backups" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Add a blob storage connection to get started.")).toBeDefined();
    const addButtons = screen.getAllByRole("button", { name: "Add connection" });
    fireEvent.click(addButtons[addButtons.length - 1]);
    expect(dialogProps).toMatchObject({ isOpen: true, editConnection: null });
  });

  describe("below the breakpoint", () => {
    beforeEach(() => {
      mobile = true;
    });

    function views() {
      const [list, detail] = Array.from(screen.getByRole("main").children) as HTMLElement[];
      return { list: !list.className.includes("hidden"), detail: !detail.className.includes("hidden") };
    }

    test("a workbench connection opens its detail, and back returns to the list", () => {
      render(<ResourceSectionPage category="messaging" />);
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(views()).toEqual({ list: true, detail: false });
      fireEvent.click(rowButton("events"));
      expect(views()).toEqual({ list: false, detail: true });
      fireEvent.click(screen.getByRole("button", { name: "Back to connections" }));
      expect(views()).toEqual({ list: true, detail: false });
    });

    test("a leaf opens its detail; a container waits for its Open button", () => {
      render(<ResourceSectionPage category="blob" initialConnectionId="res_s1" />);
      fireEvent.click(rowButton("backups"));
      fireEvent.click(screen.getByText("node folder"));
      expect(views()).toEqual({ list: true, detail: false });
      fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
      expect(views()).toEqual({ list: false, detail: true });
      fireEvent.click(screen.getByText("viewer close"));
      expect(views()).toEqual({ list: true, detail: false });

      fireEvent.click(screen.getByText("node jobs"));
      expect(views()).toEqual({ list: false, detail: true });
    });

    test("saving a workbench connection opens it; saving a tree one stays on the list", async () => {
      render(<ResourceSectionPage category="messaging" initialConnectionId="res_k1" />);
      await act(async () => {
        await dialogProps?.onConnect({ ...blob, id: "res_s2", name: "backups v2" });
      });
      expect(views()).toEqual({ list: true, detail: false });
      await act(async () => {
        await dialogProps?.onConnect({ ...kafka, id: "res_k2", name: "more events" });
      });
      expect(views()).toEqual({ list: false, detail: true });
    });
  });
});
