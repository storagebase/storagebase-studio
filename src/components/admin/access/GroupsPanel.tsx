"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accessRequest, errorText, PANEL_CLASS, useAccessData } from "./api";
import { StoreNotice } from "./StoreNotice";

/**
 * Connection groups (StorageBase fork): the named sets of managed connections a role binding
 * grants. Membership is set on the connection; a group here only has a name and a description.
 */

export interface GroupRow {
  id: string;
  name: string;
  description?: string;
  connectionCount: number;
  bindingCount: number;
}

interface GroupsResponse {
  groups: GroupRow[];
  storeAvailable: boolean;
  message?: string;
}

const EMPTY_FORM = { id: "", name: "", description: "" };

export function GroupsPanel({ onChanged }: { onChanged?: () => void }) {
  const { data, reload } = useAccessData<GroupsResponse>("/api/admin/access/groups");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditing(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      toast.error("A group needs a name");
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await accessRequest("/api/admin/access/groups", {
          method: "PUT",
          body: { id: editing, name: form.name, description: form.description },
        });
        toast.success("Group updated");
      } else {
        await accessRequest("/api/admin/access/groups", {
          method: "POST",
          body: { ...(form.id.trim() ? { id: form.id.trim() } : {}), name: form.name, description: form.description },
        });
        toast.success("Group created");
      }
      reset();
      reload();
      onChanged?.();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await accessRequest(`/api/admin/access/groups?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Group deleted");
      if (editing === id) reset();
      reload();
      onChanged?.();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  if (!data) return <p className="text-sm text-fg-muted">Loading groups…</p>;
  if (!data.storeAvailable) return <StoreNotice message={data.message} />;

  return (
    <div className="space-y-6">
      <form onSubmit={save} className={PANEL_CLASS} aria-label={editing ? "Edit group" : "New group"}>
        <h3 className="text-sm font-bold text-fg-secondary">{editing ? "Edit group" : "New group"}</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="group-id">Id (optional)</Label>
            <Input
              id="group-id"
              placeholder="payments"
              value={form.id}
              disabled={editing !== null}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              placeholder="Payments"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Description</Label>
            <Input
              id="group-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Plus className="h-3.5 w-3.5" />
            {editing ? "Save group" : "Create group"}
          </Button>
          {editing && (
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </form>

      {data.groups.length === 0 ? (
        <p className="text-sm text-fg-muted">No groups yet. Create one, then bind an app role to it.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-xl border border-hairline" aria-label="Connection groups">
          {data.groups.map((group) => (
            <li key={group.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{group.name}</p>
                <p className="text-xs text-fg-muted">
                  {group.id} · {group.connectionCount} connection(s) · {group.bindingCount} binding(s)
                  {group.description ? ` · ${group.description}` : ""}
                </p>
              </div>
              {confirming === group.id ? (
                <div className="flex items-center gap-2 text-xs text-danger">
                  <span>Deletes its bindings and removes it from every connection.</span>
                  <Button size="sm" variant="destructive" onClick={() => remove(group.id)}>
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
                    aria-label={`Edit ${group.name}`}
                    onClick={() => {
                      setEditing(group.id);
                      setForm({ id: group.id, name: group.name, description: group.description ?? "" });
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Delete ${group.name}`}
                    onClick={() => setConfirming(group.id)}
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
