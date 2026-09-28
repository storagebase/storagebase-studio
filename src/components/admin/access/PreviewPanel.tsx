"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accessRequest, errorText, PANEL_CLASS, SELECT_CLASS } from "./api";

/**
 * Access preview (StorageBase fork): "someone holding these app roles would see these managed
 * connections, at these permissions, through these bindings" — the debugging aid for a binding that
 * does not do what its administrator expected. Nothing is resolved or opened.
 */

interface PreviewRow {
  id: string;
  name: string;
  type: string;
  permission: string;
  via: string;
  roles: string[];
  groups: string[];
}

interface PreviewResponse {
  subject: { role: string; appRoles: string[] };
  databases: PreviewRow[];
  resources: PreviewRow[];
}

function PreviewTable({ title, rows }: { title: string; rows: PreviewRow[] }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h4 className="text-xs font-bold uppercase tracking-wide text-fg-muted">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">None.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Name</th>
              <th className="py-1 pr-3 font-medium">Type</th>
              <th className="py-1 pr-3 font-medium">Permission</th>
              <th className="py-1 font-medium">Granted by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-hairline">
                <td className="py-1.5 pr-3 text-fg">{row.name}</td>
                <td className="py-1.5 pr-3 text-fg-secondary">{row.type}</td>
                <td className="py-1.5 pr-3 font-mono">{row.permission}</td>
                <td className="py-1.5 text-fg-secondary">
                  {row.via === "admin-bypass" ? "admin bypass" : `${row.roles.join(", ")} via ${row.groups.join(", ")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PreviewPanel() {
  const [roles, setRoles] = useState("");
  const [studioRole, setStudioRole] = useState<"user" | "admin">("user");
  const [result, setResult] = useState<PreviewResponse | null>(null);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setResult(
        await accessRequest<PreviewResponse>("/api/admin/access/preview", {
          method: "POST",
          body: { roles: roles.split(/[\s,]+/).filter(Boolean), studioRole },
        }),
      );
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={run} className={PANEL_CLASS} aria-label="Access preview">
        <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
          <div className="space-y-1.5">
            <Label htmlFor="preview-roles">App role values</Label>
            <Input
              id="preview-roles"
              placeholder="Team.Payments.Read, Team.Ops.Write"
              value={roles}
              onChange={(e) => setRoles(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preview-studio-role">Studio role</Label>
            <select
              id="preview-studio-role"
              className={SELECT_CLASS}
              value={studioRole}
              onChange={(e) => setStudioRole(e.target.value === "admin" ? "admin" : "user")}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <Button type="submit" size="sm">
          <Eye className="h-3.5 w-3.5" />
          Preview access
        </Button>
      </form>
      {result && (
        <div className={PANEL_CLASS}>
          <p className="text-xs text-fg-muted">
            As {result.subject.role} with{" "}
            {result.subject.appRoles.length ? result.subject.appRoles.join(", ") : "no app roles"}
          </p>
          <PreviewTable title="Databases" rows={result.databases} />
          <PreviewTable title="Resources" rows={result.resources} />
        </div>
      )}
    </div>
  );
}
