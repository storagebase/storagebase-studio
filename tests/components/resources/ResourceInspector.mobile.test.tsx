import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

// Mobile path: the inspector renders a Drawer instead of a Dialog.
mock.module("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));

mock.module("@/components/ui/drawer", () => ({
  Drawer: ({
    open,
    children,
    onOpenChange,
  }: {
    open?: boolean;
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    (globalThis as Record<string, unknown>).__drawerOnOpenChange = onOpenChange;
    return open ? React.createElement("div", { "data-testid": "drawer" }, children) : null;
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "drawer-content" }, children),
  DrawerHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DrawerTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  DrawerDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
}));

import { ResourceInspector } from "@/components/resources/ResourceInspector";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const node: ResourceNode = {
  id: "bucket/fixture-blobs",
  parentId: null,
  kind: "bucket",
  name: "fixture-blobs",
  hasChildren: true,
};

describe("ResourceInspector mobile", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__drawerOnOpenChange;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the drawer path with the viewer inside", () => {
    render(<ResourceInspector connection={connection} node={node} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.getByTestId("drawer")).toBeDefined();
  });

  test("dismissing the drawer calls back", () => {
    const onClose = mock(() => {});
    render(<ResourceInspector connection={connection} node={node} onClose={onClose} onChanged={() => {}} />);
    const onOpenChange = (globalThis as Record<string, unknown>).__drawerOnOpenChange as (open: boolean) => void;
    expect(typeof onOpenChange).toBe("function");
    onOpenChange(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
