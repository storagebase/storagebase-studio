"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { accessRequest, errorText, useAccessData } from "./api";
import { typeLabel } from "./connection-fields";
import { ConnectionEditor, type AdminConnectionRow } from "./ConnectionEditor";
import { StoreNotice } from "./StoreNotice";
import type { GroupRow } from "./GroupsPanel";

/**
 * Managed (preconfigured) connections (StorageBase fork): created here, used by whoever a role
 * binding admits, and never shown to them — users get a name, a type and a permission, and their
 * browser addresses the connection by id.
 */

interface ConnectionsResponse {
  connections: AdminConnectionRow[];
  storeAvailable: boolean;
  message?: string;
}

type Editing = { row: AdminConnectionRow | null } | null;

export function ConnectionsPanel() {
  const { data, reload } = useAccessData<ConnectionsResponse>("/api/admin/access/connections");
  const groupList = useAccessData<{ groups: GroupRow[] }>("/api/admin/access/groups").data;
  const groups = groupList?.groups ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const remove = async (row: AdminConnectionRow) => {
    setConfirming(null);
    try {
      await accessRequest(`/api/admin/access/connections?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      toast.success("Connection deleted");
      reload();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  if (!data) return <p className="text-sm text-fg-muted">Loading managed connections…</p>;
  if (!data.storeAvailable) return <StoreNotice message={data.message} />;

  return (
    <div className="space-y-6">
      {editing ? (
        <ConnectionEditor
          key={editing.row?.id ?? "new"}
          row={editing.row}
          groups={groups}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : (
        <Button size="sm" onClick={() => setEditing({ row: null })}>
          <Plus className="h-3.5 w-3.5" />
          New managed connection
        </Button>
      )}

      {data.connections.length === 0 ? (
        <p className="text-sm text-fg-muted">No managed connections yet.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-xl border border-hairline" aria-label="Managed connections">
          {data.connections.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  {row.name}
                  <Badge variant="outline">{typeLabel(row.kind, row.type)}</Badge>
                </p>
                <p className="text-xs text-fg-muted">
                  {row.groupNames.length > 0 ? row.groupNames.join(", ") : "No group (administrators only)"} · updated
                  by {row.updatedBy} {new Date(row.updatedAt).toLocaleString()}
                </p>
              </div>
              {confirming === row.id ? (
                <div className="flex items-center gap-2 text-xs text-danger">
                  <span>Users lose it at once.</span>
                  <Button size="sm" variant="destructive" onClick={() => remove(row)}>
                    Confirm delete
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Edit ${row.name}`}
                    onClick={() => setEditing({ row })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Delete ${row.name}`}
                    onClick={() => setConfirming(row.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
