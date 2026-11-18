"use client";

import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { routeRefusal } from "@/components/storagebase/resources/route-refusal";
import { appFetch } from "@/lib/config/base-path";
import type { ResourceNodePage } from "@/storagebase/resources/types";
import { sectionConnectionBody, type SectionConnection } from "./connection-body";

/**
 * The Messaging page's workbench shell (StorageBase fork). The Kafka admin
 * workbench (topics, produce, consumer groups, brokers) belongs to the
 * messaging family milestone; until it lands, this is the navigation-level
 * view: the same bounded tree the resource route already serves, with the
 * connection's read-only grant honoured. The page hands it the active row and
 * the `readOnly` flag exactly as it will hand them to the full workbench, so
 * the section contract does not change when the family lands.
 */
export function SectionKafkaWorkbench({
  connection,
  readOnly = false,
}: {
  connection: SectionConnection;
  readOnly?: boolean;
}) {
  const [topics, setTopics] = useState<ResourceNodePage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTopics(null);
    setError(null);
    const read = async () => {
      try {
        const response = await appFetch("/api/sb/resources/tree", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sectionConnectionBody(connection)),
        });
        if (!response.ok) throw new Error(await routeRefusal(response, "Topics could not be read"));
        const page = (await response.json()) as ResourceNodePage;
        if (!cancelled) setTopics(page);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return (
    <div data-testid="kafka-workbench" className="h-full overflow-auto bg-surface text-fg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Messaging workbench</h2>
        {readOnly && <span className="text-xs text-fg-muted">read-only</span>}
      </div>
      {error !== null ? (
        <div data-testid="kafka-workbench-error" className="flex items-center gap-2 text-warning">
          <CircleAlert strokeWidth={1.5} className="w-4 h-4" />
          <span className="text-xs break-words">{error}</span>
        </div>
      ) : topics === null ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin" />
          <span className="text-xs">Reading topics…</span>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {topics.nodes.map((node) => (
            <li key={node.id} className="text-xs text-fg-secondary px-2 py-1.5 rounded hover:bg-fill">
              {node.name}
            </li>
          ))}
          {topics.nodes.length === 0 && <li className="text-xs text-muted-foreground">No topics listed.</li>}
          {topics.truncated && <li className="text-xs text-fg-subtle">List truncated by the provider.</li>}
        </ul>
      )}
    </div>
  );
}
