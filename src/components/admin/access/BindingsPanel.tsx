"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Link2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccessPermission } from "@/lib/access/types";
import { accessRequest, errorText, PANEL_CLASS, SELECT_CLASS, useAccessData } from "./api";
import { StoreNotice } from "./StoreNotice";
import type { GroupRow } from "./GroupsPanel";

/**
 * Role bindings (StorageBase fork): "whoever holds this app role may use this group's managed
 * connections at this permission". The role value is free text the tenant administrator defined;
 * the suggestions are only the values recent sign-ins presented — nothing is read from the directory.
 */

interface BindingRow {
  id: string;
  appRoleValue: string;
  groupId: string;
  groupName: string;
  permission: AccessPermission;
  createdBy: string;
}

interface BindingsResponse {
  bindings: BindingRow[];
  seenRoles: Array<{ value: string; lastSeenAt: string }>;
  storeAvailable: boolean;
  message?: string;
}

export const PERMISSION_HELP: Record<AccessPermission, string> = {
  read: "List, browse, reveal and download; read-only queries only.",
  write: "Read, plus create, update and delete objects, publish and produce.",
  admin: "Write, plus purge and destructive operations (delete topics, reset offsets).",
};

const EMPTY_FORM = { appRoleValue: "", groupId: "", permission: "read" as AccessPermission };

export function BindingsPanel() {
  const { data, reload } = useAccessData<BindingsResponse>("/api/admin/access/bindings");
  const groupList = useAccessData<{ groups: GroupRow[] }>("/api/admin/access/groups").data;
  const groups = groupList?.groups ?? [];
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const appRoleValue = form.appRoleValue.trim();
    if (!appRoleValue || /[\s,]/.test(appRoleValue)) {
      toast.error("An app-role value is required and has no spaces or commas");
      return;
    }
    if (!form.groupId) {
      toast.error("Pick a group");
      return;
    }
    setBusy(true);
    try {
      const result = await accessRequest<{ replaced: boolean }>("/api/admin/access/bindings", {
        method: "POST",
        body: { appRoleValue, groupId: form.groupId, permission: form.permission },
      });
      toast.success(result.replaced ? "Binding updated" : "Binding created");
      setForm(EMPTY_FORM);
      reload();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await accessRequest(`/api/admin/access/bindings?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Binding deleted");
      reload();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  if (!data) return <p className="text-sm text-fg-muted">Loading bindings…</p>;
  if (!data.storeAvailable) return <StoreNotice message={data.message} />;

  return (
    <div className="space-y-6">
      <form onSubmit={save} className={PANEL_CLASS} aria-label="New binding">
        <h3 className="text-sm font-bold text-fg-secondary">Bind an app role to a group</h3>
        {groups.length === 0 && <p className="text-xs text-fg-muted">Create a connection group first.</p>}
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="binding-role">App role value</Label>
            <Input
              id="binding-role"
              list="binding-role-suggestions"
              placeholder="Team.Payments.Read"
              value={form.appRoleValue}
              onChange={(e) => setForm({ ...form, appRoleValue: e.target.value })}
            />
            <datalist id="binding-role-suggestions">
              {data.seenRoles.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.value}
                </option>
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="binding-group">Group</Label>
            <select
              id="binding-group"
              className={SELECT_CLASS}
              value={form.groupId}
              onChange={(e) => setForm({ ...form, groupId: e.target.value })}
            >
              <option value="">Select a group…</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="binding-permission">Permission</Label>
            <select
              id="binding-permission"
              className={SELECT_CLASS}
              value={form.permission}
              onChange={(e) => setForm({ ...form, permission: e.target.value as AccessPermission })}
            >
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
            <p className="text-xs text-fg-muted">{PERMISSION_HELP[form.permission]}</p>
          </div>
        </div>
        <Button type="submit" size="sm" disabled={busy}>
          <Link2 className="h-3.5 w-3.5" />
          Save binding
        </Button>
      </form>

      {data.bindings.length === 0 ? (
        <p className="text-sm text-fg-muted">No bindings yet: no app role grants any managed connection.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-xl border border-hairline" aria-label="Role bindings">
          {data.bindings.map((binding) => (
            <li key={binding.id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
              <code className="font-mono text-fg">{binding.appRoleValue}</code>
              <span className="text-fg-muted">→</span>
              <span className="text-fg-secondary">{binding.groupName}</span>
              <Badge variant="outline">{binding.permission}</Badge>
              <span className="flex-1 text-xs text-fg-muted">by {binding.createdBy}</span>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Delete binding ${binding.appRoleValue} to ${binding.groupName}`}
                onClick={() => remove(binding.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
