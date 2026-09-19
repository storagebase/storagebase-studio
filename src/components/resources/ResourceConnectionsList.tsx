"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { getResourceIcon, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * The resource connection list — the parallel of `ConnectionsList`, fork-owned
 * and deliberately narrower: select, edit, delete, add. Favorites and manual
 * ordering stay database-only until a resource workflow needs them; carrying
 * them over speculatively would be chrome without a caller.
 */

interface ResourceConnectionsListProps {
  connections: ResourceConnection[];
  activeConnection: ResourceConnection | null;
  onSelectConnection: (conn: ResourceConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: ResourceConnection) => void;
  onAddConnection: () => void;
}

export function ResourceConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onAddConnection,
}: ResourceConnectionsListProps) {
  return (
    <div data-testid="resource-connections-list">
      <div className="px-3 mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Resources</span>
        <div className="h-[1px] flex-1 bg-border/30 ml-3" />
        <button
          type="button"
          data-testid="resource-connections-add"
          onClick={onAddConnection}
          title="Add resource connection"
          className="ml-2 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
        </button>
      </div>
      {connections.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-subtle">No resource connections yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {connections.map((conn) => {
            const Icon = getResourceIcon(conn.type);
            const cfg = RESOURCE_UI_CONFIG[conn.type];
            const isActive = activeConnection?.id === conn.id;
            return (
              <li key={conn.id}>
                <div
                  data-testid="resource-connection-row"
                  data-connection-id={conn.id}
                  aria-current={isActive ? "true" : undefined}
                  className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                    isActive ? "bg-fill text-fg" : "text-fg-secondary hover:text-fg hover:bg-fill"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectConnection(conn)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  >
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${cfg.color}`} />
                    <span className="truncate font-medium">{conn.name}</span>
                    <span className="ml-auto shrink-0 text-fg-subtle">{cfg.label}</span>
                  </button>
                  {onEditConnection && (
                    <button
                      type="button"
                      data-testid="resource-connection-edit"
                      onClick={() => onEditConnection(conn)}
                      title={`Edit ${conn.name}`}
                      className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground hover:text-foreground transition-all"
                    >
                      <Pencil strokeWidth={1.5} className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="resource-connection-delete"
                    onClick={() => onDeleteConnection(conn.id)}
                    title={`Delete ${conn.name}`}
                    className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground hover:text-danger transition-all"
                  >
                    <Trash2 strokeWidth={1.5} className="w-3 h-3" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
