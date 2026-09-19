import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

// Mock the resource children to isolate the sidebar's job: what it renders and
// what it hands over. The components' own reads are covered by their own tests.
mock.module("@/components/resources/ResourceConnectionsList", () => ({
  ResourceConnectionsList: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const connections = props.connections as Array<Record<string, unknown>> | undefined;
    return React.createElement(
      "div",
      {
        "data-testid": "resource-connections-list",
        "data-connections-count": String(connections?.length ?? 0),
        "data-active": String((props.activeConnection as Record<string, string> | null)?.id ?? "none"),
        "data-has-select": String(props.onSelectConnection !== undefined),
        "data-has-delete": String(props.onDeleteConnection !== undefined),
        "data-has-edit": String(props.onEditConnection !== undefined),
        "data-has-add": String(props.onAddConnection !== undefined),
      },
      "ResourceConnectionsList Mock",
    );
  },
}));

mock.module("@/components/resources/ResourceTree", () => ({
  ResourceTree: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement(
      "div",
      {
        "data-testid": "resource-tree",
        "data-connection": String((props.connection as Record<string, string>)?.id ?? "none"),
        "data-has-click": String(props.onNodeClick !== undefined),
        "data-refresh-token": props.refreshToken === undefined ? "none" : String(props.refreshToken),
      },
      "ResourceTree Mock",
    );
  },
}));

// Mock radix scroll area to pass through children (same shape as
// tests/components/sidebar/Sidebar.test.tsx — the export names must match
// what src/components/ui/scroll-area.tsx consumes).
mock.module("@radix-ui/react-scroll-area", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");

  const Root = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-slot": "scroll-area" }, children),
  );
  Root.displayName = "ScrollAreaRoot";

  const Viewport = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-slot": "scroll-area-viewport" }, children),
  );
  Viewport.displayName = "ScrollAreaViewport";

  const ScrollAreaScrollbar = React.forwardRef(
    ({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
      React.createElement("div", { ...props, ref }, children),
  );
  ScrollAreaScrollbar.displayName = "ScrollAreaScrollbar";

  const ScrollAreaThumb = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref }),
  );
  ScrollAreaThumb.displayName = "ScrollAreaThumb";

  const Corner = () => null;
  Corner.displayName = "Corner";

  return { Root, Viewport, ScrollAreaScrollbar, ScrollAreaThumb, Corner };
});

mock.module("@/components/object-tree", () => ({
  ObjectTree: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "object-tree" }, "ObjectTree Mock");
  },
}));

import type { DatabaseConnection } from "@/lib/types";
import type { ResourceConnection } from "@/lib/resources/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// ---- Load the component under test AFTER all mock.module registrations ----
// A static import would be hoisted and evaluate the real module tree
// (ConnectionsList, object-tree, resources/...) before the mocks apply —
// the same poisoning tests/components/sidebar/Sidebar.test.tsx documents.
const { Sidebar } = await import("@/components/sidebar/Sidebar");

const dbConnection: DatabaseConnection = {
  id: "db-1",
  name: "pg",
  type: "postgres",
  host: "localhost",
  createdAt: new Date(),
};

const resourceConnection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function baseProps() {
  return {
    connections: [] as DatabaseConnection[],
    activeConnection: null,
    onSelectConnection: mock((_c: DatabaseConnection) => {}),
    onDeleteConnection: mock((_id: string) => {}),
    onAddConnection: mock(() => {}),
    onObjectClick: mock((_o: unknown) => {}),
    onShowDiagram: mock(() => {}),
  };
}

describe("Sidebar resource sections", () => {
  test("renders nothing resource-related when the shell wires nothing", () => {
    render(<Sidebar {...baseProps()} />);
    try {
      expect(screen.queryByTestId("resource-connections-list")).toBeNull();
      expect(screen.queryByTestId("resource-tree")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("passes connections, active state and handlers to the resource list", () => {
    const onSelectResourceConnection = mock((_c: ResourceConnection) => {});
    render(
      <Sidebar
        {...baseProps()}
        resourceConnections={[resourceConnection]}
        activeResourceConnection={null}
        onSelectResourceConnection={onSelectResourceConnection}
        onDeleteResourceConnection={mock((_id: string) => {})}
        onEditResourceConnection={mock((_c: ResourceConnection) => {})}
        onAddResourceConnection={mock(() => {})}
      />,
    );
    try {
      const list = screen.getByTestId("resource-connections-list");
      expect(list.getAttribute("data-connections-count")).toBe("1");
      expect(list.getAttribute("data-active")).toBe("none");
      expect(list.getAttribute("data-has-select")).toBe("true");
      expect(list.getAttribute("data-has-delete")).toBe("true");
      expect(list.getAttribute("data-has-edit")).toBe("true");
      expect(list.getAttribute("data-has-add")).toBe("true");
      // No active resource, so no tree.
      expect(screen.queryByTestId("resource-tree")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("mounts the resource tree for the active resource connection", () => {
    const onResourceNodeClick = mock((_n: unknown) => {});
    render(
      <Sidebar
        {...baseProps()}
        connections={[dbConnection]}
        activeConnection={dbConnection}
        // The database tree only mounts once its declaration arrives; the
        // resource tree is what this test is about, so a stub suffices.
        metadata={{ capabilities: {} } as unknown as ProviderMetadata}
        resourceConnections={[resourceConnection]}
        activeResourceConnection={resourceConnection}
        onSelectResourceConnection={mock((_c: ResourceConnection) => {})}
        onDeleteResourceConnection={mock((_id: string) => {})}
        onAddResourceConnection={mock(() => {})}
        onResourceNodeClick={onResourceNodeClick}
      />,
    );
    try {
      const tree = screen.getByTestId("resource-tree");
      expect(tree.getAttribute("data-connection")).toBe("res-1");
      expect(tree.getAttribute("data-has-click")).toBe("true");
      // The database tree is untouched beside it.
      expect(screen.getByTestId("object-tree")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("hands the node-click handler to the tree", () => {
    const onResourceNodeClick = mock((_n: unknown) => {});
    render(
      <Sidebar
        {...baseProps()}
        activeResourceConnection={resourceConnection}
        onResourceNodeClick={onResourceNodeClick}
      />,
    );
    try {
      // The tree mock reports the handler's presence; ResourceTree's own tests
      // cover the click path. Presence here is the sidebar's whole job.
      expect(screen.getByTestId("resource-tree").getAttribute("data-has-click")).toBe("true");
    } finally {
      cleanup();
    }
  });

  test("hands the refresh token to the tree", () => {
    render(<Sidebar {...baseProps()} activeResourceConnection={resourceConnection} resourceRefreshToken={7} />);
    try {
      expect(screen.getByTestId("resource-tree").getAttribute("data-refresh-token")).toBe("7");
    } finally {
      cleanup();
    }
  });
});
