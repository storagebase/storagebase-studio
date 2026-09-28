"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PlugZap, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ManagedConnectionKind } from "@/lib/access/types";
import { accessRequest, errorText, PANEL_CLASS, SELECT_CLASS } from "./api";
import { ENVIRONMENTS, fieldsFor, typeOptions } from "./connection-fields";
import type { GroupRow } from "./GroupsPanel";

/**
 * Create or edit one managed connection (StorageBase fork). Credentials are write-only: the row
 * being edited carries none, a secret input left blank keeps the stored value, and "Clear" sends
 * null to remove it. "Test connection" runs the configuration as it would be saved, with the stored
 * secrets filled in on the server.
 */

export interface AdminConnectionRow {
  id: string;
  kind: ManagedConnectionKind;
  type: string;
  name: string;
  clientId: string;
  groupIds: string[];
  groupNames: string[];
  config: Record<string, unknown>;
  secretsSet: string[];
  updatedAt: string;
  updatedBy: string;
}

interface TestResult {
  success: boolean;
  degraded?: boolean;
  message: string;
  latencyMs?: number;
}

function initialValues(row: AdminConnectionRow | null): Record<string, string> {
  if (!row) return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.config)) {
    if (typeof value === "string" || typeof value === "number") values[key] = String(value);
  }
  return values;
}

export function ConnectionEditor({
  row,
  groups,
  onSaved,
  onCancel,
}: {
  /** The connection being edited, or null to create one. */
  row: AdminConnectionRow | null;
  groups: GroupRow[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ManagedConnectionKind>(row?.kind ?? "database");
  const [type, setType] = useState(row?.type ?? typeOptions("database")[0].value);
  const [id, setId] = useState("");
  const [name, setName] = useState(row?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(row));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(row?.groupIds ?? []));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const fields = fieldsFor(kind, type);
  const secretsSet = new Set(row?.secretsSet ?? []);

  const switchKind = (next: ManagedConnectionKind) => {
    setKind(next);
    setType(typeOptions(next)[0].value);
    setValues({});
    setCleared(new Set());
    setResult(null);
  };

  const setValue = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const config = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key]?.trim() ?? "";
      if (field.secret && cleared.has(field.key)) out[field.key] = null;
      else if (value === "") continue;
      else out[field.key] = field.numeric ? Number(value) : value;
    }
    if (values.environment) out.environment = values.environment;
    if (values.color?.trim()) out.color = values.color.trim();
    return out;
  };

  const test = async () => {
    setBusy(true);
    try {
      setResult(
        await accessRequest<TestResult>("/api/admin/access/connections/test", {
          method: "POST",
          body: { ...(row ? { id: row.id } : {}), kind, type, name, config: config() },
        }),
      );
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("A connection needs a name");
      return;
    }
    setBusy(true);
    try {
      const body = { name, config: config(), groupIds: [...groupIds] };
      if (row) {
        await accessRequest("/api/admin/access/connections", { method: "PUT", body: { id: row.id, ...body } });
      } else {
        await accessRequest("/api/admin/access/connections", {
          method: "POST",
          body: { ...(id.trim() ? { id: id.trim() } : {}), kind, type, ...body },
        });
      }
      toast.success(row ? "Connection updated" : "Connection created");
      onSaved();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className={PANEL_CLASS} aria-label={row ? `Edit ${row.name}` : "New managed connection"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-fg-secondary">{row ? `Edit ${row.name}` : "New managed connection"}</h3>
        {row && <span className="font-mono text-xs text-fg-muted">{row.clientId}</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <fieldset className="space-y-1.5" disabled={row !== null}>
          <legend className="text-sm font-medium">Kind</legend>
          <div className="flex gap-4 text-sm">
            {(["database", "resource"] as const).map((option) => (
              <label key={option} className="flex items-center gap-1.5">
                <input type="radio" name="kind" checked={kind === option} onChange={() => switchKind(option)} />
                {option === "database" ? "Database" : "Resource"}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="connection-type">Type</Label>
          <select
            id="connection-type"
            className={SELECT_CLASS}
            value={type}
            disabled={row !== null}
            onChange={(e) => {
              setType(e.target.value);
              setResult(null);
            }}
          >
            {typeOptions(kind).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="connection-name">Name</Label>
          <Input id="connection-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {!row && (
          <div className="space-y-1.5">
            <Label htmlFor="connection-id">Id (optional)</Label>
            <Input id="connection-id" placeholder="orders-db" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {fields.map((field) => {
          const inputId = `connection-field-${field.key}`;
          const stored = secretsSet.has(field.key);
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={inputId}>{field.label}</Label>
              <Input
                id={inputId}
                type={field.secret ? "password" : field.numeric ? "number" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                placeholder={field.secret && stored ? "Set — leave blank to keep" : undefined}
                disabled={cleared.has(field.key)}
                value={values[field.key] ?? ""}
                onChange={(e) => setValue(field.key, e.target.value)}
              />
              {field.secret && stored && (
                <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    aria-label={`Clear ${field.label}`}
                    checked={cleared.has(field.key)}
                    onChange={() => setCleared((current) => toggle(current, field.key))}
                  />
                  Clear
                </label>
              )}
            </div>
          );
        })}
        <div className="space-y-1.5">
          <Label htmlFor="connection-environment">Environment</Label>
          <select
            id="connection-environment"
            className={SELECT_CLASS}
            value={values.environment ?? ""}
            onChange={(e) => setValue("environment", e.target.value)}
          >
            <option value="">None</option>
            {ENVIRONMENTS.map((environment) => (
              <option key={environment} value={environment}>
                {environment}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="connection-color">Colour</Label>
          <Input
            id="connection-color"
            placeholder="#10B981"
            value={values.color ?? ""}
            onChange={(e) => setValue("color", e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-fg-muted">TLS and SSH tunnel settings are not editable here yet.</p>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Groups</legend>
        {groups.length === 0 ? (
          <p className="text-xs text-fg-muted">No groups yet: without one, only administrators can use it.</p>
        ) : (
          <div className="flex flex-wrap gap-4 text-sm">
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={groupIds.has(group.id)}
                  onChange={() => setGroupIds((current) => toggle(current, group.id))}
                />
                {group.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {result && (
        <output
          className={
            result.success ? (result.degraded ? "text-sm text-warning" : "text-sm text-success") : "text-sm text-danger"
          }
        >
          {result.success ? "Connected" : "Failed"}
          {result.latencyMs !== undefined ? ` in ${result.latencyMs} ms` : ""}: {result.message}
        </output>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          <Save className="h-3.5 w-3.5" />
          {row ? "Save connection" : "Create connection"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={test}>
          <PlugZap className="h-3.5 w-3.5" />
          Test connection
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
