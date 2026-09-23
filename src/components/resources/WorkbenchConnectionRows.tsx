"use client";

import React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { getResourceIcon, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import type { ResourceConnection } from "@/lib/resources/types";
import { cn } from "@/lib/utils";

/**
 * Workbench resource connections (Kafka) as rows INSIDE the sidebar's
 * Connections list — styled like `ConnectionItem` so a cluster reads as a
 * peer of the databases, while staying fork-owned: the upstream list only
 * renders whatever it is handed through its `trailingItems` slot.
 */
export function WorkbenchConnectionRows({
  connections,
  activeConnection,
  onSelect,
  onEdit,
  onDelete,
}: {
  connections: readonly ResourceConnection[];
  activeConnection: ResourceConnection | null;
  onSelect: (connection: ResourceConnection) => void;
  onEdit?: (connection: ResourceConnection) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      {connections.map((conn) => {
        const isActive = activeConnection?.id === conn.id;
        return (
          <div
            key={conn.id}
            data-testid="workbench-connection-row"
            data-connection-id={conn.id}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "group flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-200 text-xs",
              isActive
                ? "bg-brand-solid/10 text-brand"
                : "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(conn)}
              className="flex flex-1 min-w-0 items-center gap-2.5 text-left"
            >
              <span
                className={cn(
                  "p-1 rounded transition-colors",
                  isActive ? "bg-brand-tint/20" : "bg-muted group-hover:bg-accent",
                )}
              >
                {React.createElement(getResourceIcon(conn.type), {
                  className: `w-3 h-3 ${RESOURCE_UI_CONFIG[conn.type].color}`,
                })}
              </span>
              <span className="flex-1 min-w-0 truncate font-medium">{conn.name}</span>
              <span className="shrink-0 text-fg-subtle">{RESOURCE_UI_CONFIG[conn.type].label}</span>
            </button>
            {onEdit && (
              <button
                type="button"
                aria-label={`Edit ${conn.name}`}
                className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-brand-tint/20 hover:text-brand"
                onClick={() => onEdit(conn)}
              >
                <Pencil strokeWidth={1.5} className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              aria-label={`Delete ${conn.name}`}
              className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger-tint/20 hover:text-danger"
              onClick={() => onDelete(conn.id)}
            >
              <Trash2 strokeWidth={1.5} className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </>
  );
}
