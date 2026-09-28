import "../../setup-dom";
import "../../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import type { ManagedResourceConnection, ResourceConnection, ResourceNode } from "@/lib/resources/types";

// ── The page's collaborators, reduced to what it hands them ────────────────
mock.module("@/lib/resources/providers", () => ({}));

let authState = { user: { role: "user" } as { role?: string } | null, isAdmin: false, handleLogout: mock(() => {}) };
mock.module("@/hooks/use-auth", () => ({ useAuth: () => authState }));
mock.module("@/hooks/use-storage-sync", () => ({ useStorageSync: () => ({ isReady: true }) }));

let mobile = false;
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));

mock.module("@/hooks/use-resource-health", () => ({
  useResourceHealth: (conn: ResourceConnection | null) => (conn ? { status: "healthy" } : null),
}));

let managed: ManagedResourceConnection[] = [];
mock.module("@/hooks/use-managed-resource-connections", () => ({
  useManagedResourceConnections: () => ({ connections: managed, loading: false, error: null }),
}));

let kafkaProps: Record<string, unknown> | null = null;
mock.module("@/components/resources/kafka", () => ({
  KafkaWorkbench: (props: Record<string, unknown>) => {
    kafkaProps = props;
    return React.createElement("div", { "data-testid": "kafka-workbench" });
  },
}));
let vaultProps: Record<string, unknown> | null = null;
mock.module("@/components/resources/vault", () => ({
  VaultWorkbench: (props: Record<string, unknown>) => {
    vaultProps = props;
    return React.createElement("div", { "data-testid": "vault-workbench" });
  },
}));

const bucketNode: ResourceNode = {
  id: "q/folder",
  parentId: null,
  kind: "exchange",
  name: "folder",
  hasChildren: true,
};
const leafNode: ResourceNode = { id: "q/jobs", parentId: null, kind: "queue", name: "jobs", hasChildren: false };
let treeProps: Record<string, unknown> | null = null;
mock.module("@/components/resources/ResourceTree", () => ({
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
mock.module("@/components/resources/ResourceViewerPane", () => ({
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
  onConnect: (conn: ResourceConnection) => void;
} | null = null;
mock.module("@/components/sections/ResourceConnectionDialog", () => ({
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

const { ResourceSectionPage } = await import("@/components/sections/ResourceSectionPage");
const { storage } = await import("@/lib/storage");

const kafka: ResourceConnection = { id: "k1", name: "events", type: "kafka", createdAt: "2026-01-01T00:00:00.000Z" };
const rabbit: ResourceConnection = {
  id: "r1",
  name: "orders",
  type: "rabbitmq",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const bucket: ResourceConnection = { id: "s1", name: "backups", type: "s3", createdAt: "2026-01-01T00:00:00.000Z" };
const vault: ResourceConnection = { id: "v1", name: "keys", type: "openbao", createdAt: "2026-01-01T00:00:00.000Z" };
const sharedQueue: ManagedResourceConnection = {
  id: "m1",
  name: "shared queue",
  type: "sqs",
  createdAt: "2026-01-01T00:00:00.000Z",
  managed: true,
  permission: "read",
};

function rowButton(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: "span" }).closest("li") as HTMLElement;
  return within(row).getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("ResourceSectionPage", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/messaging");
    for (const conn of [kafka, rabbit, bucket, vault]) storage.saveResourceConnection(conn);
    authState = { user: { role: "user" }, isAdmin: false, handleLogout: mock(() => {}) };
    mobile = false;
    managed = [];
    kafkaProps = vaultProps = treeProps = paneProps = dialogProps = null;
  });
  afterEach(() => cleanup());

  test("lists only its own family, and a Kafka connection opens the Kafka workbench under a header naming it", () => {
    managed = [sharedQueue, { ...sharedQueue, id: "m2", type: "s3", name: "other family" }];
    render(<ResourceSectionPage category="messaging" />);
    const rows = screen.getAllByTestId("section-connection-row").map((row) => row.getAttribute("data-connection-id"));
    expect(rows).toEqual(["k1", "r1", "m1"]);
    expect(screen.getByRole("heading", { name: "events", level: 1 })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Messaging" })).toBeDefined();
    expect(screen.getByTestId("kafka-workbench")).toBeDefined();
    expect(kafkaProps).toMatchObject({ connection: { id: "k1" }, readOnly: false });
    // A workbench type draws no tree.
    expect(screen.queryByTestId("resource-tree")).toBeNull();
  });

  test("a tree type lists its tree; a leaf opens its viewer beside it, which refreshes and closes", () => {
    render(<ResourceSectionPage category="messaging" />);
    fireEvent.click(rowButton("orders"));
    expect(screen.getByRole("heading", { name: "orders", level: 1 })).toBeDefined();
    expect(treeProps).toMatchObject({ connection: { id: "r1" }, refreshToken: 0 });
    expect(screen.getByText("Select an item in the tree to browse it.")).toBeDefined();

    fireEvent.click(screen.getByText("node jobs"));
    expect(paneProps).toMatchObject({ connection: { id: "r1" }, node: leafNode, readOnly: false });
    fireEvent.click(screen.getByText("viewer changed"));
    expect(treeProps?.refreshToken).toBe(1);
    fireEvent.click(screen.getByText("viewer close"));
    expect(screen.queryByTestId("viewer-pane")).toBeNull();

    // A container is shown too; switching connections never carries a node across.
    fireEvent.click(screen.getByText("node folder"));
    expect(paneProps?.node).toEqual(bucketNode);
    fireEvent.click(rowButton("events"));
    fireEvent.click(rowButton("orders"));
    expect(screen.getByTestId("viewer-pane")).toBeDefined();
  });

  test("a managed read-only connection reaches its viewer read-only and offers no edit", () => {
    managed = [sharedQueue];
    render(<ResourceSectionPage category="messaging" initialConnectionId="m1" />);
    expect(screen.getByRole("heading", { name: "shared queue", level: 1 })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
    fireEvent.click(screen.getByText("node jobs"));
    expect(paneProps?.readOnly).toBe(true);
  });

  test("a managed Kafka connection granted read reaches the workbench read-only", () => {
    managed = [{ ...sharedQueue, id: "m3", type: "kafka", name: "shared cluster" }];
    render(<ResourceSectionPage category="messaging" initialConnectionId="m3" />);
    expect(kafkaProps).toMatchObject({ connection: { id: "m3" }, readOnly: true });
  });

  test("every vault opens the vault workbench, told whether the viewer is an admin", () => {
    authState = { ...authState, isAdmin: true };
    render(<ResourceSectionPage category="vault" />);
    expect(screen.getAllByTestId("section-connection-row")).toHaveLength(1);
    expect(vaultProps).toMatchObject({ connection: { id: "v1" }, isAdmin: true, readOnly: false });
  });

  test("add, edit and duplicate open the family's form; a save becomes the active connection", () => {
    render(<ResourceSectionPage category="messaging" />);
    fireEvent.click(screen.getByRole("button", { name: "Add messaging connection" }));
    expect(dialogProps).toMatchObject({ isOpen: true, editConnection: null, category: "messaging" });
    const sqs: ResourceConnection = { id: "q1", name: "jobs", type: "sqs", createdAt: "2026-01-01T00:00:00.000Z" };
    act(() => dialogProps?.onConnect(sqs));
    expect(dialogProps?.isOpen).toBe(false);
    expect(screen.getByRole("heading", { name: "jobs", level: 1 })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit orders" }));
    expect(dialogProps?.editConnection?.id).toBe("r1");
    act(() => dialogProps?.onClose());
    expect(dialogProps?.isOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Duplicate orders" }));
    expect(dialogProps?.editConnection).toMatchObject({ name: "orders (copy)", type: "rabbitmq" });
    expect(dialogProps?.editConnection?.id).not.toBe("r1");

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(dialogProps?.editConnection?.id).toBe("q1");
  });

  test("delete asks first; confirming removes, dismissing keeps", () => {
    render(<ResourceSectionPage category="messaging" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete orders" }));
    expect(within(screen.getByTestId("confirm-delete")).getByText("orders")).toBeDefined();
    act(() => alertOpenChange?.(true));
    expect(screen.getByTestId("confirm-delete")).toBeDefined();
    act(() => alertOpenChange?.(false));
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
    expect(storage.getResourceConnections().some((c) => c.id === "r1")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete orders" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(storage.getResourceConnections().some((c) => c.id === "r1")).toBe(false);
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
      render(<ResourceSectionPage category="messaging" initialConnectionId="r1" />);
      fireEvent.click(screen.getByText("node folder"));
      expect(views()).toEqual({ list: true, detail: false });
      fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
      expect(views()).toEqual({ list: false, detail: true });
      fireEvent.click(screen.getByText("viewer close"));
      expect(views()).toEqual({ list: true, detail: false });

      fireEvent.click(screen.getByText("node jobs"));
      expect(views()).toEqual({ list: false, detail: true });
    });

    test("saving a workbench connection opens it; saving a tree one stays on the list", () => {
      render(<ResourceSectionPage category="messaging" initialConnectionId="r1" />);
      act(() => dialogProps?.onConnect({ ...rabbit, name: "orders v2" }));
      expect(views()).toEqual({ list: true, detail: false });
      act(() => dialogProps?.onConnect({ ...kafka, id: "k2", name: "more events" }));
      expect(views()).toEqual({ list: false, detail: true });
    });
  });
});
