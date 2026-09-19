import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";

import { BlobBrowser } from "@/components/resources/blob/BlobBrowser";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const containerNode: ResourceNode = {
  id: "bucket/fixture-blobs",
  parentId: null,
  kind: "bucket",
  name: "fixture-blobs",
  hasChildren: true,
};

const objectNode: ResourceNode = {
  id: "bucket/fixture-blobs/hello.txt",
  parentId: "bucket/fixture-blobs",
  kind: "object",
  name: "hello.txt",
  meta: { size: 18 },
  hasChildren: false,
};

function mockRoutes(overrides: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "api/resources/tree": {
      json: {
        nodes: [
          {
            id: "bucket/fixture-blobs/hello.txt",
            parentId: "bucket/fixture-blobs",
            kind: "object",
            name: "hello.txt",
            hasChildren: false,
          },
        ],
        truncated: false,
      },
    },
    "api/resources/blob/meta": {
      json: {
        id: "bucket/fixture-blobs/hello.txt",
        name: "hello.txt",
        sizeBytes: 18,
        lastModified: null,
        contentType: "text/plain",
      },
    },
    "api/resources/blob/preview": {
      json: { kind: "text", text: "hello storagebase\n", truncated: false, contentType: "text/plain" },
    },
    "api/resources/blob/download": { json: {}, status: 200 },
    "api/resources/blob/upload": {
      json: { id: "x", name: "new.txt", sizeBytes: 5, lastModified: null, contentType: null },
    },
    "api/resources/blob/delete": { json: { deleted: true } },
    ...overrides,
  });
}

describe("BlobBrowser", () => {
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

  test("a container lists its children with an upload control", async () => {
    mockRoutes();
    render(<BlobBrowser {...props} node={containerNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });
    expect(screen.getByText("hello.txt")).toBeDefined();
    expect(screen.getByRole("button", { name: "Upload here" })).toBeDefined();
  });

  test("upload posts base64 content under the node prefix and notifies", async () => {
    const fetchMock = mockRoutes();
    render(<BlobBrowser {...props} node={containerNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "new.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    const uploadCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("api/resources/blob/upload"));
    expect(uploadCall).toBeDefined();
    const body = JSON.parse((uploadCall?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ bucket: "fixture-blobs", name: "new.txt" });
    expect(typeof body.contentBase64).toBe("string");
    expect(screen.getByText("Uploaded new.txt.")).toBeDefined();
  });

  test("an object previews with meta, download and two-click delete", async () => {
    mockRoutes();
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });
    expect(screen.getByText("hello storagebase")).toBeDefined();
    expect(screen.getByText("18 bytes")).toBeDefined();

    // First click arms, second click deletes and closes.
    const deleteButton = screen.getByTestId("blob-browser-delete");
    fireEvent.click(deleteButton);
    expect(deleteButton.textContent).toContain("Click again to confirm");
    expect(props.onChanged).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test("a failed delete surfaces the server sentence and stays open", async () => {
    mockRoutes({
      "api/resources/blob/delete": { json: { message: "socket reset" }, status: 502 },
    });
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("blob-browser-delete");
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  test("binary and image previews name their kind instead of dumping bytes", async () => {
    mockRoutes({
      "api/resources/blob/preview": {
        json: { kind: "binary", truncated: false, contentType: "application/octet-stream" },
      },
    });
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview-note")).toBeDefined();
    });
    expect(screen.queryByTestId("blob-browser-preview")).toBeNull();
  });
});
