import "../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { ResourceTree } from "@/components/resources/ResourceTree";
import type { ResourceConnection, ResourceNodePage } from "@/lib/resources/types";

const connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const rootsPage: ResourceNodePage = {
  nodes: [
    { id: "buckets", parentId: null, kind: "prefix", name: "buckets", hasChildren: true },
    {
      id: "buckets/photos",
      parentId: "buckets",
      kind: "bucket",
      name: "photos",
      meta: { objects: 12 },
      hasChildren: true,
    },
    { id: "orphan.txt", parentId: null, kind: "object", name: "orphan.txt", meta: { size: 10 }, hasChildren: false },
  ],
  truncated: false,
};

const childrenPage: ResourceNodePage = {
  nodes: [
    { id: "buckets/photos/a.jpg", parentId: "buckets/photos", kind: "object", name: "a.jpg", hasChildren: false },
  ],
  truncated: true,
};

function mockTree(pages: Record<string, ResourceNodePage>) {
  return mockGlobalFetch({
    "api/resources/tree": async (req: Request) => {
      const body = (await req.json()) as { connection: ResourceConnection; parent?: string };
      // The connection travels whole; the tree never invents addressing.
      if (body.connection.id !== connection.id) {
        return { status: 400, json: { message: "wrong connection" } };
      }
      const page = pages[body.parent ?? "root"];
      if (!page) return { status: 500, json: { message: "no such level" } };
      return { json: page };
    },
  });
}

describe("ResourceTree", () => {
  beforeEach(() => {
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("loads and renders the root level on mount", async () => {
    const fetchMock = mockTree({ root: rootsPage });

    render(<ResourceTree connection={connection} />);

    expect(screen.getByTestId("resource-tree-loading")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("photos")).toBeDefined();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.connection).toMatchObject({ id: "res-1", type: "s3" });
    expect(body).not.toHaveProperty("parent");
    // Meta renders, leaves have no toggle.
    expect(screen.getByText("orphan.txt")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    const rows = screen.getAllByTestId("resource-tree-node");
    expect(rows).toHaveLength(3);
  });

  test("expanding a container loads its children once", async () => {
    const fetchMock = mockGlobalFetch({
      "api/resources/tree": async (req: Request) => {
        const body = (await req.json()) as { parent?: string };
        return { json: body.parent ? childrenPage : rootsPage };
      },
    });

    const onNodeClick = mock((_node: unknown) => {});
    render(<ResourceTree connection={connection} onNodeClick={onNodeClick} />);

    await waitFor(() => {
      expect(screen.getByText("photos")).toBeDefined();
    });

    const photosRow = screen.getByText("photos").closest("button") as HTMLButtonElement;
    fireEvent.click(photosRow);

    await waitFor(() => {
      expect(screen.getByText("a.jpg")).toBeDefined();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, childInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    expect((JSON.parse(childInit.body as string) as { parent: string }).parent).toBe("buckets/photos");
    // Truncation is the provider's own flag, rendered as-is.
    expect(screen.getByText("List truncated by the provider.")).toBeDefined();
    expect(onNodeClick).toHaveBeenCalledTimes(1);

    // Collapsing hides children without refetching; re-expanding uses the cache.
    fireEvent.click(photosRow);
    expect(screen.queryByText("a.jpg")).toBeNull();
    fireEvent.click(photosRow);
    expect(screen.getByText("a.jpg")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("clicking a leaf notifies without fetching", async () => {
    mockTree({ root: rootsPage });
    const onNodeClick = mock((_node: unknown) => {});
    render(<ResourceTree connection={connection} onNodeClick={onNodeClick} />);

    await waitFor(() => {
      expect(screen.getByText("orphan.txt")).toBeDefined();
    });

    fireEvent.click(screen.getByText("orphan.txt").closest("button") as HTMLButtonElement);

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    const node = onNodeClick.mock.calls[0][0] as { id: string };
    expect(node.id).toBe("orphan.txt");
  });

  test("a failed level shows the server sentence with a retry", async () => {
    let attempts = 0;
    mockGlobalFetch({
      "api/resources/tree": () => {
        attempts += 1;
        if (attempts === 1) return { status: 500, json: { message: "socket refused" } };
        return { json: rootsPage };
      },
    });

    render(<ResourceTree connection={connection} />);

    await waitFor(() => {
      expect(screen.getByTestId("resource-tree-error")).toBeDefined();
    });
    expect(screen.getByText("socket refused")).toBeDefined();

    fireEvent.click(screen.getByTestId("resource-tree-retry"));

    await waitFor(() => {
      expect(screen.getByText("photos")).toBeDefined();
    });
    expect(attempts).toBe(2);
  });

  test("empty roots render the empty copy", async () => {
    mockTree({ root: { nodes: [], truncated: false } });

    render(<ResourceTree connection={connection} />);

    await waitFor(() => {
      expect(screen.getByTestId("resource-tree-empty")).toBeDefined();
    });
  });

  test("a network failure renders the error state", async () => {
    mockGlobalFetch({
      "api/resources/tree": () => {
        throw new Error("down");
      },
    });

    render(<ResourceTree connection={connection} />);

    await waitFor(() => {
      expect(screen.getByTestId("resource-tree-error")).toBeDefined();
    });
  });
});
