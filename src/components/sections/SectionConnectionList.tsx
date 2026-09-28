"use client";

import React from "react";
import { Copy, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { getResourceIcon, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import { isManagedResourceConnection, type ResourceConnection, type ResourcePermission } from "@/lib/resources/types";
import { cn } from "@/lib/utils";

const PERMISSION_LABEL: Record<ResourcePermission, string> = {
  read: "read-only",
  write: "read-write",
  admin: "admin",
};

interface SectionConnectionListProps {
  /** The viewer's own connections and the managed ones, in the order to show. */
  connections: readonly ResourceConnection[];
  activeId: string | null;
  /** "blob storage", "messaging", "vault" — how the empty state names the list. */
  noun: string;
  onSelect: (conn: ResourceConnection) => void;
  onEdit: (conn: ResourceConnection) => void;
  onDuplicate: (conn: ResourceConnection) => void;
  onDelete: (conn: ResourceConnection) => void;
  onAdd: () => void;
  managedLoading?: boolean;
  managedError?: string | null;
}

/**
 * A section page's connection list: styled like the Databases page's
 * `ConnectionsList` rows, so a queue or a vault reads as a peer of a database,
 * but fork-owned and narrower — no favourites, no manual order.
 *
 * A managed row (an admin's connection this viewer may use) carries a lock,
 * the word Managed and what it grants, and no edit, duplicate or delete: it
 * is not the viewer's to change. No row renders a credential; the list shows
 * name, type and grant only.
 */
export function SectionConnectionList({
  connections,
  activeId,
  noun,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onAdd,
  managedLoading = false,
  managedError = null,
}: SectionConnectionListProps) {
  return (
    <section data-testid="section-connection-list" aria-label="Connections" className="space-y-1">
      {connections.length === 0 ? (
        <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-1">
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">No {noun} connections yet.</p>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-solid hover:bg-brand-solid-hover text-white px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint/50"
          >
            <Plus strokeWidth={1.5} className="w-3 h-3" />
            Add connection
          </button>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {connections.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              active={conn.id === activeId}
              onSelect={onSelect}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      {managedLoading && <p className="px-3 py-1 text-xs text-fg-subtle">Loading managed connections…</p>}
      {managedError && (
        <p role="alert" className="px-3 py-1 text-xs text-warning leading-relaxed break-words">
          Managed connections could not be loaded: {managedError}
        </p>
      )}
    </section>
  );
}

const actionClass =
  // Always visible on touch screens, which have no hover to reveal them.
  "p-1 rounded md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint/50";

function ConnectionRow({
  conn,
  active,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  conn: ResourceConnection;
  active: boolean;
  onSelect: (conn: ResourceConnection) => void;
  onEdit: (conn: ResourceConnection) => void;
  onDuplicate: (conn: ResourceConnection) => void;
  onDelete: (conn: ResourceConnection) => void;
}) {
  const cfg = RESOURCE_UI_CONFIG[conn.type];
  const managed = isManagedResourceConnection(conn) ? conn : null;
  return (
    <li
      data-testid="section-connection-row"
      data-connection-id={conn.id}
      data-managed={managed ? "true" : undefined}
      className={cn(
        "group flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors",
        active ? "bg-brand-solid/10 text-brand" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(conn)}
        aria-current={active ? "true" : undefined}
        title={managed?.groupNames?.length ? `Managed · granted by ${managed.groupNames.join(", ")}` : undefined}
        className="flex flex-1 min-w-0 items-center gap-2.5 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint/50"
      >
        <span className={cn("p-1 rounded shrink-0", active ? "bg-brand-tint/20" : "bg-muted group-hover:bg-accent")}>
          {React.createElement(getResourceIcon(conn.type), { className: `w-3 h-3 ${cfg.color}` })}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate font-medium">{conn.name}</span>
          <span className="flex items-center gap-1.5 text-fg-subtle">
            <span className="truncate">{cfg.label}</span>
            {managed && (
              <>
                <span data-testid="managed-badge" className="inline-flex items-center gap-0.5 shrink-0">
                  <Lock strokeWidth={1.5} className="w-2.5 h-2.5" aria-hidden="true" />
                  Managed
                </span>
                <span
                  data-testid="permission-badge"
                  className="shrink-0 rounded px-1 border border-hairline text-fg-muted leading-tight"
                >
                  {PERMISSION_LABEL[managed.permission]}
                </span>
              </>
            )}
          </span>
        </span>
      </button>
      {!managed && (
        <>
          <button
            type="button"
            aria-label={`Edit ${conn.name}`}
            onClick={() => onEdit(conn)}
            className={cn(actionClass, "hover:bg-brand-tint/20 hover:text-brand")}
          >
            <Pencil strokeWidth={1.5} className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Duplicate ${conn.name}`}
            onClick={() => onDuplicate(conn)}
            className={cn(actionClass, "hover:bg-brand-tint/20 hover:text-brand")}
          >
            <Copy strokeWidth={1.5} className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${conn.name}`}
            onClick={() => onDelete(conn)}
            className={cn(actionClass, "hover:bg-danger-tint/20 hover:text-danger")}
          >
            <Trash2 strokeWidth={1.5} className="w-3 h-3" />
          </button>
        </>
      )}
    </li>
  );
}
