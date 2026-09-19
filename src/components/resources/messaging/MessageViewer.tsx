"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { appFetch } from "@/lib/config/base-path";
import { registerResourceViewer, type ResourceViewerProps } from "@/components/resources/viewer-registry";
import type { ResourceNode } from "@/lib/resources/types";
import type { BrowseMessagesPage } from "@/lib/resources/operations";

/**
 * The messaging family viewer, registered for `kafka`, `rabbitmq` and `sqs`:
 * topics and queues browse with a publish box, exchanges publish with a
 * routing-key field and cannot be browsed (they hold no messages — the
 * provider refuses that with its own sentence, and this viewer does not offer
 * the button in the first place).
 *
 * Peek costs are stated where they are incurred: RabbitMQ requeues every
 * peeked message and SQS receives with visibility zero, so the list header
 * says what "browse" costs on each family instead of letting it read as free.
 * Deletes (purge) are two-click; the confirm lives here, the trail on the route.
 */

const PEEK_COST: Record<string, string> = {
  kafka: "Reading from the beginning, oldest first.",
  rabbitmq: "Each message is requeued after peeking — expect redeliveries.",
  sqs: "Received with visibility zero: messages reappear immediately and may duplicate.",
};

const BROWSEABLE_KINDS = new Set(["topic", "queue"]);

async function postMessage(path: string, payload: Record<string, unknown>): Promise<Response> {
  return appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metaChips(node: ResourceNode): string[] {
  return Object.entries(node.meta ?? {})
    .filter(([name, value]) => name !== "preview" && name !== "previewTruncated" && value !== null && value !== "")
    .map(([name, value]) => `${name}: ${String(value)}`);
}

export function MessageViewer({ connection, node, onChanged, onClose }: ResourceViewerProps) {
  const [page, setPage] = useState<BrowseMessagesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState("");
  const [routingKey, setRoutingKey] = useState("");
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const browseable = BROWSEABLE_KINDS.has(node.kind);
  const basePayload = { connection, destination: node.id };

  const load = useCallback(async () => {
    if (!browseable) return;
    setError(null);
    try {
      const response = await postMessage("/api/resources/message/browse", { ...basePayload, limit: 50 });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Browse failed");
      setPage((await response.json()) as BrowseMessagesPage);
    } catch (loadError) {
      setError(toMessage(loadError));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id]);

  useEffect(() => {
    setPage(null);
    setError(null);
    setNotice(null);
    setPurgeArmed(false);
    setBody("");
    setRoutingKey("");
    void load();
  }, [load]);

  const handlePublish = useCallback(async () => {
    if (body.trim() === "") return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await postMessage("/api/resources/message/publish", {
        ...basePayload,
        body,
        ...(node.kind === "exchange" && routingKey.trim() !== ""
          ? { attributes: { routingKey: routingKey.trim() } }
          : {}),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Publish failed");
      setBody("");
      setNotice("Published.");
      onChanged?.();
      await load();
    } catch (publishError) {
      setError(toMessage(publishError));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id, body, routingKey, onChanged, load]);

  const handlePurge = useCallback(async () => {
    if (!purgeArmed) {
      setPurgeArmed(true);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await postMessage("/api/resources/message/purge", basePayload);
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? "Purge failed");
      setNotice("Purged.");
      onChanged?.();
      await load();
    } catch (purgeError) {
      setError(toMessage(purgeError));
    } finally {
      setBusy(false);
      setPurgeArmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, node.id, purgeArmed, onChanged, load]);

  return (
    <div data-testid="message-viewer" className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg truncate">{node.name}</h3>
        <span className="text-xs text-fg-subtle">{node.kind}</span>
      </div>

      {error && (
        <p data-testid="message-viewer-error" className="text-xs text-danger leading-relaxed break-words">
          {error}
        </p>
      )}
      {notice && <p className="text-xs text-success">{notice}</p>}

      {browseable ? (
        <div className="space-y-3">
          <p className="text-xs text-fg-subtle">
            {PEEK_COST[connection.type] ?? "Peek costs are documented per family."}
          </p>
          {page === null ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin" />
              <span className="text-xs">Reading…</span>
            </div>
          ) : page.messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">No messages.</p>
          ) : (
            <ul className="space-y-1.5">
              {page.messages.map((message) => (
                <li
                  key={message.id}
                  data-testid="message-viewer-message"
                  data-node-id={message.id}
                  className="rounded-md border border-hairline bg-panel px-2 py-1.5"
                >
                  <div className="text-xs font-medium text-fg truncate">{message.name}</div>
                  {typeof message.meta?.preview === "string" && message.meta.preview !== "" && (
                    <div className="text-xs font-mono text-fg-secondary truncate">{message.meta.preview}</div>
                  )}
                  {metaChips(message).length > 0 && (
                    <div className="text-xs text-fg-subtle truncate">{metaChips(message).join(" · ")}</div>
                  )}
                </li>
              ))}
              {page.truncated && <li className="text-xs text-fg-subtle px-1">More messages remain.</li>}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Exchanges hold no messages — publish below routes through this exchange instead.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="message-viewer-body" className="text-xs font-mediumr text-fg-muted">
          Publish a message
        </Label>
        <textarea
          id="message-viewer-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message body"
          rows={3}
          className="w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 text-xs text-fg-secondary p-2 resize-y placeholder:text-fg-subtle"
        />
        {node.kind === "exchange" && (
          <Input
            value={routingKey}
            onChange={(e) => setRoutingKey(e.target.value)}
            placeholder="Routing key (optional)"
            aria-label="Routing key"
            className="h-9 bg-panel border-hairline focus:border-brand-tint/50 text-xs"
          />
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || body.trim() === ""}
            onClick={handlePublish}
            className="text-xs"
          >
            <Send strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Publish
          </Button>
          {browseable && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={handlePurge}
              data-testid="message-viewer-purge"
              className={purgeArmed ? "text-xs text-danger border-danger-tint/30" : "text-xs"}
            >
              <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              {purgeArmed ? "Click again to confirm" : "Purge"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs text-fg-muted">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

registerResourceViewer("kafka", MessageViewer);
registerResourceViewer("rabbitmq", MessageViewer);
registerResourceViewer("sqs", MessageViewer);
