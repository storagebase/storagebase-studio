"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appFetch } from "@/lib/config/base-path";
import { registerResourceViewer, type ResourceViewerProps } from "@/components/resources/viewer-registry";
import type { ResourceNode, ResourceNodePage } from "@/lib/resources/types";
import type { BlobObjectMeta, BlobPreview } from "@/lib/resources/operations";

/**
 * The blob family viewer, registered for `s3` and `azure-blob`: containers
 * and prefixes browse their children with an upload control, leaves preview
 * with download and delete. Everything reads through the routes the family
 * owns (`/api/resources/blob/*` + the shared tree route); the component holds
 * no SDK and no addressing grammar beyond splitting its own node id.
 *
 * Deletes are two-click (arm, then confirm) — the degraded-save precedent:
 * the confirm dialog lives client-side, the audit trail on the route.
 * Uploads post base64 inside the route's size cap; larger objects go through
 * the provider SDKs directly, not this viewer.
 */

async function postBlob(path: string, payload: Record<string, unknown>): Promise<Response> {
  return appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Split a viewer node id into its bucket and key-or-prefix. Both families
 * address `scheme/<bucket>/<rest>` with bucket names that never contain `/`.
 */
function splitViewerAddress(node: ResourceNode): { bucket: string; rest: string } {
  const parts = node.id.split("/");
  return { bucket: parts[1] ?? "", rest: parts.slice(2).join("/") };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BlobBrowser({ connection, node, onChanged, onClose }: ResourceViewerProps) {
  const [children, setChildren] = useState<ResourceNodePage | null>(null);
  const [meta, setMeta] = useState<BlobObjectMeta | null>(null);
  const [preview, setPreview] = useState<BlobPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [uploadState, setUploadState] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const address = splitViewerAddress(node);
  const basePayload = { connection, bucket: address.bucket };

  const load = useCallback(async () => {
    setError(null);
    try {
      if (node.hasChildren) {
        const response = await postBlob("/api/resources/tree", { connection, parent: node.id });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Tree read failed");
        setChildren((await response.json()) as ResourceNodePage);
      } else {
        const [metaResponse, previewResponse] = await Promise.all([
          postBlob("/api/resources/blob/meta", { ...basePayload, name: address.rest }),
          postBlob("/api/resources/blob/preview", { ...basePayload, name: address.rest, byteLimit: 65536 }),
        ]);
        if (!metaResponse.ok) {
          throw new Error((await metaResponse.json().catch(() => null))?.message ?? "Metadata read failed");
        }
        if (!previewResponse.ok) {
          throw new Error((await previewResponse.json().catch(() => null))?.message ?? "Preview failed");
        }
        setMeta((await metaResponse.json()) as BlobObjectMeta);
        setPreview((await previewResponse.json()) as BlobPreview);
      }
    } catch (loadError) {
      setError(toMessage(loadError));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id]);

  useEffect(() => {
    setChildren(null);
    setMeta(null);
    setPreview(null);
    setDeleteArmed(false);
    setUploadState(null);
    void load();
  }, [load]);

  const handleDownload = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await postBlob("/api/resources/blob/download", { ...basePayload, name: address.rest });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = node.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(toMessage(downloadError));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id]);

  const handleDelete = useCallback(async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await postBlob("/api/resources/blob/delete", { ...basePayload, name: address.rest });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Delete failed");
      onChanged?.();
      onClose?.();
    } catch (deleteError) {
      setError(toMessage(deleteError));
    } finally {
      setBusy(false);
      setDeleteArmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id, deleteArmed, onChanged, onClose]);

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null);
      setUploadState(null);
      setBusy(true);
      try {
        const prefix = address.rest.endsWith("/") || address.rest === "" ? address.rest : `${address.rest}/`;
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        const response = await postBlob("/api/resources/blob/upload", {
          ...basePayload,
          name: `${prefix}${file.name}`,
          contentBase64: btoa(binary),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Upload failed");
        setUploadState(`Uploaded ${file.name}.`);
        onChanged?.();
        await load();
      } catch (uploadError) {
        setError(toMessage(uploadError));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection.id, node.id, onChanged, load],
  );

  return (
    <div data-testid="blob-browser" className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg truncate">{node.name}</h3>
        <span className="text-xs text-fg-subtle">{node.kind}</span>
      </div>

      {error && (
        <p data-testid="blob-browser-error" className="text-xs text-danger leading-relaxed break-words">
          {error}
        </p>
      )}

      {node.hasChildren ? (
        <div className="space-y-3">
          {children === null ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin" />
              <span className="text-xs">Reading…</span>
            </div>
          ) : children.nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing listed here yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {children.nodes.map((child) => (
                <li
                  key={child.id}
                  className="px-1 py-1.5 text-xs text-fg-secondary flex items-center gap-2"
                  data-testid="blob-browser-child"
                  data-node-id={child.id}
                >
                  <span className="truncate">{child.name}</span>
                </li>
              ))}
              {children.truncated && <li className="text-xs text-fg-subtle px-1">List truncated by the provider.</li>}
            </ul>
          )}
          <div>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleUpload(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="text-xs"
            >
              <Upload strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Upload here
            </Button>
            {uploadState && <p className="mt-2 text-xs text-success">{uploadState}</p>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {meta && (
            <dl className="text-xs space-y-1">
              <div className="flex gap-2">
                <dt className="text-fg-subtle">Size</dt>
                <dd className="text-fg-secondary">{meta.sizeBytes === null ? "unknown" : `${meta.sizeBytes} bytes`}</dd>
              </div>
              {meta.lastModified && (
                <div className="flex gap-2">
                  <dt className="text-fg-subtle">Modified</dt>
                  <dd className="text-fg-secondary">{meta.lastModified}</dd>
                </div>
              )}
              {meta.contentType && (
                <div className="flex gap-2">
                  <dt className="text-fg-subtle">Type</dt>
                  <dd className="text-fg-secondary">{meta.contentType}</dd>
                </div>
              )}
            </dl>
          )}
          {preview?.kind === "text" && (
            <pre
              data-testid="blob-browser-preview"
              className="text-xs font-mono bg-panel border border-hairline rounded-md p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words"
            >
              {preview.text}
              {preview.truncated && <span className="text-fg-subtle">…truncated</span>}
            </pre>
          )}
          {preview?.kind === "image" && (
            <p data-testid="blob-browser-preview-note" className="text-xs text-muted-foreground">
              Image preview — download to view the full object.
            </p>
          )}
          {preview?.kind === "binary" && (
            <p data-testid="blob-browser-preview-note" className="text-xs text-muted-foreground">
              Binary object — download to inspect it.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={handleDownload} className="text-xs">
              <Download strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Download
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={handleDelete}
              data-testid="blob-browser-delete"
              className={deleteArmed ? "text-xs text-danger border-danger-tint/30" : "text-xs"}
            >
              <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              {deleteArmed ? "Click again to confirm" : "Delete"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

registerResourceViewer("s3", BlobBrowser);
registerResourceViewer("azure-blob", BlobBrowser);
