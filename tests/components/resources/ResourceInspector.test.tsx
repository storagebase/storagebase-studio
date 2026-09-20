import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

// ── Mock framer-motion (viewer buttons) ─────────────────────────────────────
mock.module("framer-motion", () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);
  return {
    motion: new Proxy({}, { get: () => passthrough }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

mock.module("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

let capturedDialogProps: Record<string, unknown> = {};

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open?: boolean;
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    capturedDialogProps = { open, onOpenChange };
    return open ? React.createElement("div", { "data-testid": "dialog" }, children) : null;
  },
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dialog-content" }, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DialogClose: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

// The inspector imports the real viewer barrels (self-registration, like
// production); the completeness test below pins every type to a viewer.
import { ResourceInspector } from "@/components/resources/ResourceInspector";
import { hasResourceViewer } from "@/components/resources/viewer-registry";
import { RESOURCE_TYPES } from "@/lib/resources/types";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const s3Connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const objectNode: ResourceNode = {
  id: "bucket/fixture-blobs/hello.txt",
  parentId: "bucket/fixture-blobs",
  kind: "object",
  name: "hello.txt",
  hasChildren: false,
};

describe("ResourceInspector", () => {
  const props = {
    onClose: mock(() => {}),
    onChanged: mock(() => {}),
  };

  beforeEach(() => {
    props.onClose.mockClear();
    props.onChanged.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the registered viewer for the connection type", async () => {
    mockGlobalFetch({
      "api/resources/blob/meta": {
        json: { id: "x", name: "hello.txt", sizeBytes: 18, lastModified: null, contentType: "text/plain" },
      },
      "api/resources/blob/preview": {
        json: { kind: "text", text: "hello", truncated: false, contentType: "text/plain" },
      },
    });

    render(<ResourceInspector connection={s3Connection} node={objectNode} {...props} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser")).toBeDefined();
    });
    expect(screen.queryByTestId("resource-inspector-fallback")).toBeNull();
  });

  test("every resource type resolves a viewer — getResourceViewer never misses", () => {
    // All ten type-ids registered a viewer with their family; a miss throws
    // instead of rendering nothing, so this fails when a family forgets a
    // registration. RESOURCE_TYPES is the union's only list.
    for (const type of RESOURCE_TYPES) {
      expect(hasResourceViewer(type), type).toBe(true);
    }
  });

  test("renders an empty dialog without a connection and node", () => {
    // The shell never mounts this state (it gates on both), so the contract
    // is only "renders without crashing and shows no viewer".
    render(<ResourceInspector connection={null} node={null} {...props} />);
    expect(screen.queryByTestId("blob-browser")).toBeNull();
    expect(screen.getByTestId("dialog")).toBeDefined();
  });

  test("dismissing the dialog calls back", () => {
    const onClose = mock(() => {});
    mockGlobalFetch({
      "api/resources/blob/meta": {
        json: { id: "x", name: "hello.txt", sizeBytes: 18, lastModified: null, contentType: "text/plain" },
      },
      "api/resources/blob/preview": {
        json: { kind: "text", text: "hello", truncated: false, contentType: "text/plain" },
      },
    });
    render(<ResourceInspector connection={s3Connection} node={objectNode} onClose={onClose} onChanged={() => {}} />);

    const onOpenChange = capturedDialogProps.onOpenChange as (open: boolean) => void;
    expect(typeof onOpenChange).toBe("function");
    onOpenChange(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
