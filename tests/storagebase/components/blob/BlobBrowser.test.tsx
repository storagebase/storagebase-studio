import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { hasResourceViewer } from "@/components/storagebase/resources/viewer-registry";
import type { ResourceConnection, ResourceNode } from "@/storagebase/resources/types";

/**
 * BlobBrowser tests (fork port of the legacy component test, moved by path,
 * with the upload half rewritten for multipart: the browser attaches the File
 * as a `file` part — no base64 conversion, no JSON string of megabytes. The
 * viewer-registry, the connection-body and the route-refusal helper are the
 * REAL fork modules (the section shell owns the registry); only global fetch
 * is doubled, so the component is exercised against exactly what production
 * imports.
 */

const connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
};

const containerNode: ResourceNode = {
  id: "container/fixture-blobs",
  parentId: null,
  kind: "container",
  name: "fixture-blobs",
  hasChildren: true,
};

const prefixNode: ResourceNode = {
  id: "container/fixture-blobs/reports/",
  parentId: "container/fixture-blobs",
  kind: "prefix",
  name: "reports",
  hasChildren: true,
};

const objectNode: ResourceNode = {
  id: "container/fixture-blobs/hello.txt",
  parentId: "container/fixture-blobs",
  kind: "blob",
  name: "hello.txt",
  meta: { size: 18 },
  hasChildren: false,
};

function mockRoutes(overrides: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "api/sb/resources/tree": {
      json: {
        nodes: [
          {
            id: "container/fixture-blobs/hello.txt",
            parentId: "container/fixture-blobs",
            kind: "blob",
            name: "hello.txt",
            hasChildren: false,
          },
        ],
        truncated: false,
      },
    },
    "api/sb/blob/meta": {
      json: {
        id: "container/fixture-blobs/hello.txt",
        name: "hello.txt",
        sizeBytes: 18,
        lastModified: null,
        contentType: "text/plain",
      },
    },
    "api/sb/blob/preview": {
      json: { kind: "text", text: "hello storagebase\n", truncated: false, contentType: "text/plain" },
    },
    "api/sb/blob/download": { json: {}, status: 200 },
    "api/sb/blob/upload": {
      json: { id: "x", name: "new.txt", sizeBytes: 5, lastModified: null, contentType: null },
    },
    "api/sb/blob/delete": { json: { deleted: true } },
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

  test("registers itself for azure-blob through the family barrel", async () => {
    // The barrel import is the registration side effect the section shell
    // relies on; loading it here pins the viewer into the real registry.
    await import("@/components/storagebase/resources/blob");
    expect(hasResourceViewer("azure-blob")).toBe(true);
  });

  test("a container lists its children with an upload control", async () => {
    mockRoutes();
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={containerNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });
    expect(screen.getByText("hello.txt")).toBeDefined();
    expect(screen.getByRole("button", { name: "Upload here" })).toBeDefined();
  });

  test("an empty container says so instead of drawing an empty list", async () => {
    mockRoutes({
      "api/sb/resources/tree": { json: { nodes: [], truncated: false } },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={containerNode} />);

    await waitFor(() => {
      expect(screen.getByText("Nothing listed here yet.")).toBeDefined();
    });
    expect(screen.queryByTestId("blob-browser-child")).toBeNull();
    expect(screen.getByRole("button", { name: "Upload here" })).toBeDefined();
  });

  test("upload posts the file as a multipart part and notifies", async () => {
    const fetchMock = mockRoutes();
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
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
    const uploadCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("api/sb/blob/upload"));
    expect(uploadCall).toBeDefined();
    if (uploadCall === undefined) throw new Error("expected upload call");

    // Multipart, not base64: the File travels as a file part beside the
    // addressing fields, with no Content-Type header (the boundary is the
    // browser's to set) and the inline connection stringified as a form
    // field, exactly what the route's multipart reader parses back.
    const init = uploadCall[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(JSON.parse(form.get("connection") as string)).toMatchObject({ id: "res-1", type: "azure-blob" });
    expect(form.get("bucket")).toBe("fixture-blobs");
    expect(form.get("name")).toBe("new.txt");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(init.headers).toBeUndefined();
    expect(screen.getByText("Uploaded new.txt.")).toBeDefined();
  });

  test("an upload inside a prefix addresses the prefix", async () => {
    const fetchMock = mockRoutes();
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={prefixNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "f.txt")] } });

    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalled();
    });
    const uploadCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("api/sb/blob/upload"));
    expect(uploadCall).toBeDefined();
    if (uploadCall === undefined) throw new Error("expected upload call");
    const form = (uploadCall[1] as RequestInit).body as FormData;
    expect(form.get("bucket")).toBe("fixture-blobs");
    expect(form.get("name")).toBe("reports/f.txt");
  });

  test("an object previews with meta, download and two-click delete", async () => {
    mockRoutes();
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
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

  test("an object with a modification time shows it in the meta drawer", async () => {
    mockRoutes({
      "api/sb/blob/meta": {
        json: {
          id: "container/fixture-blobs/hello.txt",
          name: "hello.txt",
          sizeBytes: 18,
          lastModified: "2026-02-03T04:05:06.000Z",
          contentType: "text/plain",
        },
      },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByText("Modified")).toBeDefined();
    });
    expect(screen.getByText("2026-02-03T04:05:06.000Z")).toBeDefined();
    expect(screen.getByText("18 bytes")).toBeDefined();
    expect(screen.getByText("text/plain")).toBeDefined();
  });

  test("an image preview names its kind instead of dumping bytes", async () => {
    mockRoutes({
      "api/sb/blob/preview": {
        json: { kind: "image", truncated: false, contentType: "image/png", sizeBytes: 1024 },
      },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview-note")).toBeDefined();
    });
    expect(screen.getByText("Image preview — download to view the full object.")).toBeDefined();
    expect(screen.queryByTestId("blob-browser-preview")).toBeNull();
  });

  test("a failed delete surfaces the server sentence and stays open", async () => {
    mockRoutes({
      "api/sb/blob/delete": { json: { error: "socket reset" }, status: 502 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
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
    expect(screen.getByText("socket reset")).toBeDefined();
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  test("an older { message } refusal shape still shows its sentence", async () => {
    mockRoutes({
      "api/sb/blob/delete": { json: { message: "legacy shape" }, status: 502 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });

    const deleteButton = screen.getByTestId("blob-browser-delete");
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByText("legacy shape")).toBeDefined();
    });
  });

  test("a non-JSON refusal falls back to the caller's own words", async () => {
    mockRoutes({
      "api/sb/blob/meta": { text: "<html>bad gateway</html>", status: 502 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(screen.getByText("Metadata read failed")).toBeDefined();
  });

  test("a failed metadata read surfaces the server sentence", async () => {
    mockRoutes({
      "api/sb/blob/meta": { json: { error: "gone" }, status: 404 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(screen.getByText("gone")).toBeDefined();
  });

  test("a failed preview surfaces the server sentence", async () => {
    mockRoutes({
      "api/sb/blob/preview": { json: { error: "unreadable" }, status: 500 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(screen.getByText("unreadable")).toBeDefined();
  });

  test("a failed download surfaces the server sentence", async () => {
    mockRoutes({
      "api/sb/blob/download": { json: { error: "denied" }, status: 403 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(screen.getByText("denied")).toBeDefined();
  });

  test("a failed upload surfaces the server sentence", async () => {
    mockRoutes({
      "api/sb/blob/upload": { json: { error: "quota" }, status: 507 },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={containerNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "f.txt")] } });

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-error")).toBeDefined();
    });
    expect(screen.getByText("quota")).toBeDefined();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  test("download saves the bytes through an object URL", async () => {
    mockRoutes();
    const createObjectURL = mock(() => "blob:mock-url");
    const revokeObjectURL = mock(() => {});
    const anchorClick = mock(() => {});
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalCreateElement = document.createElement.bind(document);
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    const createElementSpy = mock((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === "a") element.click = anchorClick as unknown as () => void;
      return element;
    });
    document.createElement = createElementSpy as unknown as typeof document.createElement;
    try {
      const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
      render(<BlobBrowser {...props} node={objectNode} />);

      await waitFor(() => {
        expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
      });

      fireEvent.click(screen.getByRole("button", { name: "Download" }));

      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalledTimes(1);
      });
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      document.createElement = originalCreateElement;
    }
  });

  test("binary and image previews name their kind instead of dumping bytes", async () => {
    mockRoutes({
      "api/sb/blob/preview": {
        json: { kind: "binary", truncated: false, contentType: "application/octet-stream" },
      },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview-note")).toBeDefined();
    });
    expect(screen.queryByTestId("blob-browser-preview")).toBeNull();
  });

  test("a truncated preview says so", async () => {
    mockRoutes({
      "api/sb/blob/preview": {
        json: { kind: "text", text: "once upon a time", truncated: true, contentType: "text/plain" },
      },
    });
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    render(<BlobBrowser {...props} node={objectNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });
    expect(screen.getByText("…truncated")).toBeDefined();
  });

  test("read-only lists and previews, downloads, and offers no upload or delete", async () => {
    mockRoutes();
    const { BlobBrowser } = await import("@/components/storagebase/resources/blob/BlobBrowser");
    const { unmount } = render(<BlobBrowser {...props} node={containerNode} readOnly />);
    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-child")).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Upload here" })).toBeNull();
    unmount();

    render(<BlobBrowser {...props} node={objectNode} readOnly />);
    await waitFor(() => {
      expect(screen.getByTestId("blob-browser-preview")).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Download" })).toBeDefined();
    expect(screen.queryByTestId("blob-browser-delete")).toBeNull();
  });
});
