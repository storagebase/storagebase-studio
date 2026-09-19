"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { appFetch } from "@/lib/config/base-path";
import type { ResourceConnection, ResourceNode, ResourceNodePage } from "@/lib/resources/types";

/**
 * The resource object tree — the parallel of `ObjectTree`, fork-owned and
 * deliberately lighter: providers answer bounded pages (`ResourceNodePage`)
 * with an honest `truncated` flag, so there is nothing to window and no
 * declaration to read first. Levels load lazily; the tree branches on
 * `hasChildren`, never on `kind` (the provider contract, mirroring the object
 * tree's ruling). Node `meta` is rendered, never redacted client-side: the
 * contract says it never carries credentials.
 *
 * The parent remounts per connection (`key={connection.id}`) — expansion state
 * belongs to one connection's addressing, not the panel.
 */

interface ResourceTreeProps {
  connection: ResourceConnection;
  onNodeClick?: (node: ResourceNode) => void;
}

interface LevelState {
  page: ResourceNodePage | null;
  error: string | null;
  loading: boolean;
}

const ROOT_KEY = "";

function levelKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tree read failed";
}

export function ResourceTree({ connection, onNodeClick }: ResourceTreeProps) {
  const [levels, setLevels] = useState<Record<string, LevelState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** The read itself, state-free so the mount effect can await it first. */
  const fetchLevel = useCallback(
    async (parentId: string | null): Promise<ResourceNodePage> => {
      const response = await appFetch("/api/resources/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection,
          ...(parentId === null ? {} : { parent: parentId }),
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(failure?.message ?? `Tree read failed (${response.status})`);
      }
      return (await response.json()) as ResourceNodePage;
    },
    [connection],
  );

  const loadLevel = useCallback(
    async (parentId: string | null) => {
      const key = levelKey(parentId);
      setLevels((prev) => ({ ...prev, [key]: { page: prev[key]?.page ?? null, error: null, loading: true } }));
      try {
        const page = await fetchLevel(parentId);
        setLevels((prev) => ({ ...prev, [key]: { page, error: null, loading: false } }));
      } catch (error) {
        setLevels((prev) => ({ ...prev, [key]: { page: null, error: toMessage(error), loading: false } }));
      }
    },
    [fetchLevel],
  );

  // Roots load once, with the mount: the first state write lands after the
  // read resolves, never synchronously in the effect body. Expansion state
  // belongs to one connection's addressing, and the parent remounts per
  // connection (`key={connection.id}`), so there is no reset path here.
  useEffect(() => {
    let cancelled = false;
    fetchLevel(null).then(
      (page) => {
        if (!cancelled) setLevels({ [ROOT_KEY]: { page, error: null, loading: false } });
      },
      (error: unknown) => {
        if (!cancelled) setLevels({ [ROOT_KEY]: { page: null, error: toMessage(error), loading: false } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchLevel]);

  const toggleNode = useCallback(
    (node: ResourceNode) => {
      onNodeClick?.(node);
      if (!node.hasChildren) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
          if (!levels[levelKey(node.id)]?.page) void loadLevel(node.id);
        }
        return next;
      });
    },
    [levels, loadLevel, onNodeClick],
  );

  const renderLevel = (parentId: string | null, depth: number): React.ReactNode => {
    const state = levels[levelKey(parentId)];

    if (!state || (state.loading && !state.page)) {
      return (
        <div data-testid="resource-tree-loading" className="flex items-center gap-2 py-6 text-muted-foreground">
          <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin text-brand/40" />
          <span className="text-xs">Reading…</span>
        </div>
      );
    }

    if (state.error) {
      return (
        <div data-testid="resource-tree-error" className="flex flex-col items-start gap-2 py-4">
          <div className="flex items-center gap-2 text-warning">
            <CircleAlert strokeWidth={1.5} className="w-4 h-4" />
            <span className="text-xs font-medium">This level could not be read</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed break-words">{state.error}</p>
          <button
            type="button"
            data-testid="resource-tree-retry"
            onClick={() => void loadLevel(parentId)}
            className="rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }

    const nodes = state.page?.nodes ?? [];
    if (nodes.length === 0) {
      return (
        <p data-testid="resource-tree-empty" className="text-xs text-muted-foreground py-4 px-1">
          Nothing listed here yet.
        </p>
      );
    }

    return (
      <ul className="space-y-0.5">
        {nodes.map((node) => {
          const isOpen = expanded.has(node.id);
          const meta = Object.entries(node.meta ?? {})
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([, value]) => String(value))
            .join(" · ");
          return (
            <li key={node.id}>
              <button
                type="button"
                data-testid="resource-tree-node"
                data-node-id={node.id}
                onClick={() => toggleNode(node)}
                style={{ paddingLeft: `${depth * 14 + 4}px` }}
                className="w-full flex items-center gap-1.5 px-1 py-1.5 rounded-md text-xs text-fg-secondary hover:text-fg hover:bg-fill text-left transition-colors"
              >
                {node.hasChildren ? (
                  <span data-testid="resource-tree-toggle" className="shrink-0 text-fg-muted">
                    {isOpen ? (
                      <ChevronDown strokeWidth={1.5} className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight strokeWidth={1.5} className="w-3.5 h-3.5" />
                    )}
                  </span>
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className={cn("truncate", node.hasChildren && "font-medium")}>{node.name}</span>
                {meta && <span className="ml-auto pl-2 truncate text-fg-subtle">{meta}</span>}
              </button>
              {isOpen && node.hasChildren && renderLevel(node.id, depth + 1)}
            </li>
          );
        })}
        {state.page?.truncated && (
          <li>
            <p className="text-xs text-fg-subtle py-1 px-1">List truncated by the provider.</p>
          </li>
        )}
      </ul>
    );
  };

  return (
    <div data-testid="resource-tree" className="min-h-0">
      {renderLevel(null, 0)}
    </div>
  );
}
