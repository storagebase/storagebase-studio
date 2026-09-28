import "../../setup-dom";

import React from "react";
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";

let mobile = false;
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));

let formProps: Record<string, unknown> = {};
mock.module("@/components/resources/ResourceConnectionForm", () => ({
  ResourceConnectionForm: (props: Record<string, unknown>) => {
    formProps = props;
    return React.createElement("div", { "data-testid": "resource-form" });
  },
}));

let openChange: ((open: boolean) => void) | undefined;
function shell(testId: string) {
  function Shell({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) {
    openChange = onOpenChange;
    return open ? React.createElement("div", { "data-testid": testId }, children) : null;
  }
  return Shell;
}
const passthrough = ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children);
mock.module("@/components/ui/dialog", () => ({
  Dialog: shell("dialog"),
  DialogContent: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
}));
mock.module("@/components/ui/drawer", () => ({
  Drawer: shell("drawer"),
  DrawerContent: passthrough,
  DrawerHeader: passthrough,
  DrawerTitle: passthrough,
  DrawerDescription: passthrough,
}));

const { ResourceConnectionDialog } = await import("@/components/sections/ResourceConnectionDialog");
import type { ResourceConnection } from "@/lib/resources/types";

const vault: ResourceConnection = { id: "v1", name: "keys", type: "openbao", createdAt: "2026-01-01T00:00:00.000Z" };

describe("ResourceConnectionDialog", () => {
  const onClose = mock(() => {});
  const onConnect = mock((_c: ResourceConnection) => {});

  beforeEach(() => {
    mobile = false;
    formProps = {};
    openChange = undefined;
    onClose.mockClear();
  });
  afterEach(() => cleanup());

  test("a dialog holding the form pinned to the page's category", () => {
    render(
      <ResourceConnectionDialog
        category="vault"
        isOpen
        onClose={onClose}
        onConnect={onConnect}
        editConnection={null}
      />,
    );
    expect(screen.getByTestId("dialog")).toBeDefined();
    expect(screen.getAllByText("New Connection").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configure a vault connection.").length).toBeGreaterThan(0);
    expect(formProps).toMatchObject({ category: "vault", isOpen: true, editConnection: null, onConnect, onClose });
    // Opening is the page's to decide; only a close is reported.
    openChange?.(true);
    expect(onClose).not.toHaveBeenCalled();
    openChange?.(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("an edit says so, and a phone gets a drawer", () => {
    mobile = true;
    render(
      <ResourceConnectionDialog
        category="vault"
        isOpen
        onClose={onClose}
        onConnect={onConnect}
        editConnection={vault}
      />,
    );
    expect(screen.getByTestId("drawer")).toBeDefined();
    expect(screen.getAllByText("Edit Connection").length).toBeGreaterThan(0);
    expect(formProps.editConnection).toBe(vault);
    openChange?.(true);
    expect(onClose).not.toHaveBeenCalled();
    openChange?.(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closed renders nothing", () => {
    render(
      <ResourceConnectionDialog
        category="blob"
        isOpen={false}
        onClose={onClose}
        onConnect={onConnect}
        editConnection={null}
      />,
    );
    expect(screen.queryByTestId("dialog")).toBeNull();
  });
});
