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

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", { "data-testid": "dialog" }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dialog-content" }, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DialogClose: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

// The inspector imports the real blob viewer barrel (self-registration, like
// production); kafka has no viewer, which is exactly what the fallback test needs.
import { ResourceInspector } from "@/components/resources/ResourceInspector";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const s3Connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const vaultConnection: ResourceConnection = {
  id: "res-2",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const objectNode: ResourceNode = {
  id: "bucket/fixture-blobs/hello.txt",
  parentId: "bucket/fixture-blobs",
  kind: "object",
  name: "hello.txt",
  hasChildren: false,
};

const secretNode: ResourceNode = {
  id: "storagebase/fixture",
  parentId: null,
  kind: "secret",
  name: "fixture",
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

  test("unregistered types degrade to the fallback, naming the type", () => {
    render(<ResourceInspector connection={vaultConnection} node={secretNode} {...props} />);

    const fallback = screen.getByTestId("resource-inspector-fallback");
    expect(fallback.textContent).toContain("hashicorp-vault");
  });

  test("renders nothing without a connection and node", () => {
    render(<ResourceInspector connection={null} node={null} {...props} />);
    expect(screen.queryByTestId("blob-browser")).toBeNull();
    expect(screen.queryByTestId("resource-inspector-fallback")).toBeNull();
  });
});
