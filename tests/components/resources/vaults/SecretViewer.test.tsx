import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";

import { SecretViewer } from "@/components/resources/vaults/SecretViewer";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const connection: ResourceConnection = {
  id: "res-1",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:8210",
};

const secretNode: ResourceNode = {
  id: "mount/storagebase/fixture",
  parentId: "mount/storagebase",
  kind: "secret",
  name: "fixture",
  hasChildren: false,
};

const folderNode: ResourceNode = {
  id: "mount/storagebase/nested/",
  parentId: "mount/storagebase",
  kind: "folder",
  name: "nested",
  hasChildren: true,
};

function mockRoutes(overrides: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "api/resources/tree": {
      json: {
        nodes: [
          {
            id: "mount/storagebase/nested/deep",
            parentId: "mount/storagebase/nested/",
            kind: "secret",
            name: "deep",
            hasChildren: false,
          },
        ],
        truncated: false,
      },
    },
    "api/resources/secret/read": {
      json: { name: "storagebase/fixture", value: "s3cret-value", metadata: { version: "1", createdAt: null } },
    },
    "api/resources/secret/write": { json: { written: true } },
    "api/resources/secret/delete": { json: { deleted: true } },
    ...overrides,
  });
}

describe("SecretViewer", () => {
  const props = {
    connection,
    onChanged: mock(() => {}),
    onClose: mock(() => {}),
  };

  beforeEach(() => {
    props.onChanged.mockClear();
    props.onClose.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("values render masked until revealed", async () => {
    mockRoutes();
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-value")).toBeDefined();
    });
    const value = screen.getByTestId("secret-viewer-value");
    expect(value.getAttribute("data-masked")).toBe("true");
    expect(value.textContent).not.toContain("s3cret-value");

    fireEvent.click(screen.getByTestId("secret-viewer-reveal"));
    expect(screen.getByTestId("secret-viewer-value").getAttribute("data-masked")).toBe("false");
    expect(screen.getByTestId("secret-viewer-value").textContent).toContain("s3cret-value");
  });

  test("saving posts the draft and notifies", async () => {
    const fetchMock = mockRoutes();
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-value")).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "fresh-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    const writeCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("secret/write"));
    expect(writeCall).toBeDefined();
    if (writeCall === undefined) throw new Error("expected write call");
    const body = JSON.parse((writeCall[1] as RequestInit).body as string) as Record<string, unknown>;
    // The tree id's scheme prefix is stripped: the route reads mount/rest.
    expect(body).toMatchObject({ path: "storagebase/fixture", value: "fresh-value" });
    expect(screen.getByText("Saved.")).toBeDefined();
  });

  test("delete is two-click and closes", async () => {
    mockRoutes();
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-value")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("secret-viewer-delete");
    fireEvent.click(deleteButton);
    expect(deleteButton.textContent).toContain("Click again to confirm");
    expect(props.onChanged).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("folders browse children without secret controls", async () => {
    mockRoutes();
    render(<SecretViewer {...props} node={folderNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-child")).toBeDefined();
    });
    expect(screen.getByText("deep")).toBeDefined();
    expect(screen.queryByTestId("secret-viewer-value")).toBeNull();
    expect(screen.queryByTestId("secret-viewer-delete")).toBeNull();
  });

  test("a failed read surfaces the server sentence", async () => {
    mockRoutes({
      "api/resources/secret/read": { json: { message: "sealed" }, status: 500 },
    });
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-error")).toBeDefined();
    });
    expect(screen.getByText("sealed")).toBeDefined();
  });

  test("a failed save surfaces the server sentence and keeps the draft", async () => {
    mockRoutes({
      "api/resources/secret/write": { json: { message: "denied" }, status: 403 },
    });
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-value")).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "kept-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-error")).toBeDefined();
    });
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  test("a failed delete surfaces the server sentence and stays open", async () => {
    mockRoutes({
      "api/resources/secret/delete": { json: { message: "denied" }, status: 403 },
    });
    render(<SecretViewer {...props} node={secretNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-value")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("secret-viewer-delete");
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByTestId("secret-viewer-error")).toBeDefined();
    });
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
