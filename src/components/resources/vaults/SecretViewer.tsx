"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { appFetch } from "@/lib/config/base-path";
import { registerResourceViewer, type ResourceViewerProps } from "@/components/resources/viewer-registry";
import type { ResourceNode, ResourceNodePage } from "@/lib/resources/types";
import type { SecretRead } from "@/lib/resources/operations";

/**
 * The vault family viewer, registered for all five vault type-ids: values
 * stay masked until revealed, writes go through a textarea, deletes are
 * two-click. Folders browse their children through the shared tree route;
 * leaves read and write through the secret routes.
 *
 * Masking is the whole point of this viewer, so it is uniform, not clever:
 * every value renders masked until the reader asks, including KMS key
 * metadata (harmless there, load-bearing everywhere else). There is no copy
 * button — exfiltration gets no affordance beyond reading.
 * Reveal and copy-equivalents are audited server-side on the read route;
 * masking itself is presentation, never a security boundary.
 */

async function postSecret(path: string, payload: Record<string, unknown>): Promise<Response> {
  return appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function masked(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length <= 8) return "••••••••";
  return `•••••••• (last 4: ${value.slice(-4)})`;
}

export function SecretViewer({ connection, node, onChanged, onClose }: ResourceViewerProps) {
  const [children, setChildren] = useState<ResourceNodePage | null>(null);
  const [secret, setSecret] = useState<SecretRead | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const basePayload = { connection, path: secretPathOf(node) };

  const load = useCallback(async () => {
    setError(null);
    try {
      if (node.hasChildren) {
        const response = await postSecret("/api/resources/tree", { connection, parent: node.id });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Tree read failed");
        setChildren((await response.json()) as ResourceNodePage);
      } else {
        const response = await postSecret("/api/resources/secret/read", basePayload);
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Read failed");
        const read = (await response.json()) as SecretRead;
        setSecret(read);
        setDraft(read.value);
      }
    } catch (loadError) {
      setError(toMessage(loadError));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id]);

  useEffect(() => {
    setChildren(null);
    setSecret(null);
    setRevealed(false);
    setDraft("");
    setDeleteArmed(false);
    setNotice(null);
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await postSecret("/api/resources/secret/write", { ...basePayload, value: draft });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Write failed");
      setNotice("Saved.");
      setRevealed(false);
      onChanged?.();
      await load();
    } catch (saveError) {
      setError(toMessage(saveError));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id, draft, onChanged, load]);

  const handleDelete = useCallback(async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await postSecret("/api/resources/secret/delete", basePayload);
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

  return (
    <div data-testid="secret-viewer" className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg truncate">{node.name}</h3>
        <span className="text-xs text-fg-subtle">{node.kind}</span>
      </div>

      {error && (
        <p data-testid="secret-viewer-error" className="text-xs text-danger leading-relaxed break-words">
          {error}
        </p>
      )}
      {notice && <p className="text-xs text-success">{notice}</p>}

      {node.hasChildren ? (
        children === null ? (
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
                data-testid="secret-viewer-child"
                data-node-id={child.id}
                className="px-1 py-1.5 text-xs text-fg-secondary"
              >
                <span className="truncate">{child.name}</span>
              </li>
            ))}
            {children.truncated && <li className="text-xs text-fg-subtle px-1">List truncated by the provider.</li>}
          </ul>
        )
      ) : secret === null ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin" />
          <span className="text-xs">Reading…</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md bg-panel border border-hairline p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-fg-subtle">Value</span>
              <button
                type="button"
                data-testid="secret-viewer-reveal"
                onClick={() => setRevealed((value) => !value)}
                className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
              >
                {revealed ? (
                  <EyeOff strokeWidth={1.5} className="w-3.5 h-3.5" />
                ) : (
                  <Eye strokeWidth={1.5} className="w-3.5 h-3.5" />
                )}
                {revealed ? "Mask" : "Reveal"}
              </button>
            </div>
            <pre
              data-testid="secret-viewer-value"
              data-masked={revealed ? "false" : "true"}
              className="text-xs font-mono whitespace-pre-wrap break-words text-fg-secondary"
            >
              {revealed ? secret.value : masked(secret.value)}
            </pre>
            {(secret.metadata?.version || secret.metadata?.createdAt) && (
              <p className="text-xs text-fg-subtle">
                {[secret.metadata.version && `v${secret.metadata.version}`, secret.metadata.createdAt]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-viewer-draft" className="text-xs font-mediumr text-fg-muted">
              New value
            </Label>
            <textarea
              id="secret-viewer-draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              className="w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 text-xs font-mono text-fg-secondary p-2 resize-y placeholder:text-fg-subtle"
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={handleSave} className="text-xs">
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={handleDelete}
                data-testid="secret-viewer-delete"
                className={deleteArmed ? "text-xs text-danger border-danger-tint/30" : "text-xs"}
              >
                <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
                {deleteArmed ? "Click again to confirm" : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The address the secret routes read: the tree id minus its scheme prefix
 * (`mount/<m>/<p>` → `<m>/<p>`, `secret/<n>` → `<n>`, `key/<id>` → `<id>`).
 * Providers accept both forms, so this is normalization, not parsing.
 */
function secretPathOf(node: ResourceNode): string {
  return node.id.replace(/^(mount|secret|key)\//, "");
}

registerResourceViewer("hashicorp-vault", SecretViewer);
registerResourceViewer("openbao", SecretViewer);
registerResourceViewer("azure-key-vault", SecretViewer);
registerResourceViewer("aws-secrets-manager", SecretViewer);
registerResourceViewer("aws-kms", SecretViewer);
