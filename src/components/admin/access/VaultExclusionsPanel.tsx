"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useManagedResourceConnections } from "@/hooks/use-managed-resource-connections";
import { resourceConnectionBody } from "@/lib/resources/connection-body";
import { isManagedResourceConnection, RESOURCE_CATEGORY_OF, type ResourceConnection } from "@/lib/resources/types";
import { RESOURCE_TYPE_ORDER, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import type {
  VaultExclusionKind,
  VaultExclusionObjectType,
  VaultExclusionRule,
  VaultExclusionRuleInput,
  VaultExclusionVaultType,
} from "@/lib/resources/vault-exclusions";
import { storage } from "@/lib/storage";
import { accessRequest, errorText, PANEL_CLASS, SELECT_CLASS, useAccessData } from "./api";
import { StoreNotice } from "./StoreNotice";

/**
 * Vault exclusions (StorageBase fork): one global rule list, each rule "on vaults of this type
 * whose identity matches this pattern, hide objects of this type whose name matches that pattern".
 * The server enforces the enabled rules on every vault request, for everyone, admins included, and
 * decides which vault a request is from the connection IT resolved — nothing this screen sends
 * names a vault. Preview asks the server how many objects of one vault the rules would hide:
 * counts only, never a name. See docs/resources/azure-key-vault.md.
 */

interface RulesResponse {
  rules: VaultExclusionRule[];
  storeAvailable: boolean;
  message?: string;
}

type Counts = Record<string, { total: number; hidden: number }>;

interface PreviewResult {
  applicableRules: number;
  counts: Counts;
}

const VAULT_TYPES = RESOURCE_TYPE_ORDER.filter((type) => RESOURCE_CATEGORY_OF[type] === "vault");

const KIND_LABEL: Record<VaultExclusionKind, string> = { exact: "exact", glob: "glob", regex: "regex" };

const OBJECT_TYPE_LABEL: Record<VaultExclusionObjectType, string> = {
  any: "Any object",
  secret: "Secrets",
  key: "Keys",
  certificate: "Certificates",
};

const EMPTY_FORM: VaultExclusionRuleInput = {
  vaultType: "any",
  vaultPattern: "",
  vaultPatternKind: "glob",
  objectPattern: "",
  objectPatternKind: "glob",
  objectType: "any",
  enabled: true,
  note: "",
};

function vaultTypeLabel(type: VaultExclusionVaultType): string {
  return type === "any" ? "Any vault" : RESOURCE_UI_CONFIG[type].label;
}

function inputOf(rule: VaultExclusionRule): VaultExclusionRuleInput {
  return {
    vaultType: rule.vaultType,
    vaultPattern: rule.vaultPattern,
    vaultPatternKind: rule.vaultPatternKind,
    objectPattern: rule.objectPattern,
    objectPatternKind: rule.objectPatternKind,
    objectType: rule.objectType,
    enabled: rule.enabled,
    note: rule.note,
  };
}

/** The vault connections this admin can preview against: managed ones by id, and their own. */
function useVaultConnections(): ResourceConnection[] {
  const managed = useManagedResourceConnections().connections;
  const [own] = useState<ResourceConnection[]>(() => storage.getResourceConnections());
  return useMemo(
    () => [...managed, ...own].filter((connection) => RESOURCE_CATEGORY_OF[connection.type] === "vault"),
    [managed, own],
  );
}

function KindSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: VaultExclusionKind;
  onChange: (kind: VaultExclusionKind) => void;
}) {
  return (
    <select
      id={id}
      className={SELECT_CLASS}
      value={value}
      onChange={(e) => onChange(e.target.value as VaultExclusionKind)}
    >
      <option value="glob">Glob (* and ?)</option>
      <option value="regex">Regex</option>
      <option value="exact">Exact</option>
    </select>
  );
}

function PreviewSection({ draft }: { draft: VaultExclusionRuleInput }) {
  const connections = useVaultConnections();
  const [chosen, setChosen] = useState("");
  const [result, setResult] = useState<{ label: string; value: PreviewResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const connection = connections.find((candidate) => candidate.id === chosen);

  const run = async (label: string, rules?: VaultExclusionRuleInput[]) => {
    if (!connection) {
      toast.error("Pick a vault connection to preview against");
      return;
    }
    setBusy(true);
    try {
      const value = await accessRequest<PreviewResult>("/api/resources/admin/vault-exclusions/preview", {
        method: "POST",
        body: { ...resourceConnectionBody(connection), ...(rules === undefined ? {} : { rules }) },
      });
      setResult({ label, value });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={PANEL_CLASS} aria-label="Preview">
      <h3 className="text-sm font-bold text-fg-secondary">Preview</h3>
      <p className="text-xs text-fg-muted">
        Counts only: the server lists the vault unfiltered and answers how many objects the rules would hide, never
        which ones.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 space-y-1.5">
          <Label htmlFor="exclusion-preview-connection">Vault connection</Label>
          <select
            id="exclusion-preview-connection"
            className={SELECT_CLASS}
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              setResult(null);
            }}
          >
            <option value="">Select a vault…</option>
            {connections.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} ({RESOURCE_UI_CONFIG[candidate.type].label}
                {isManagedResourceConnection(candidate) ? ", managed" : ""})
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("Saved rules")}>
          <Eye className="h-3.5 w-3.5" />
          Preview saved rules
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("The rule in the form", [draft])}>
          <Eye className="h-3.5 w-3.5" />
          Preview the form&apos;s rule
        </Button>
      </div>
      {connections.length === 0 && <p className="text-xs text-fg-muted">No vault connection to preview against.</p>}
      {result && (
        <div data-testid="vault-exclusion-preview" className="space-y-1 text-sm text-fg-secondary">
          <p>
            {result.label}: {result.value.applicableRules}{" "}
            {result.value.applicableRules === 1 ? "rule applies" : "rules apply"} to this vault.
          </p>
          <ul>
            {Object.entries(result.value.counts).map(([type, count]) => (
              <li key={type}>
                Would hide {count.hidden} of {count.total} {OBJECT_TYPE_LABEL[type as VaultExclusionObjectType]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function VaultExclusionsPanel() {
  const { data, reload } = useAccessData<RulesResponse>("/api/resources/admin/vault-exclusions");
  const [form, setForm] = useState<VaultExclusionRuleInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (patch: Partial<VaultExclusionRuleInput>) => setForm({ ...form, ...patch });

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditing(null);
    setError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accessRequest("/api/resources/admin/vault-exclusions", {
        method: editing === null ? "POST" : "PUT",
        body: editing === null ? form : { ...form, id: editing },
      });
      toast.success(editing === null ? "Exclusion rule created" : "Exclusion rule updated");
      reset();
      reload();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: VaultExclusionRule) => {
    try {
      await accessRequest("/api/resources/admin/vault-exclusions", {
        method: "PUT",
        body: { ...inputOf(rule), enabled: !rule.enabled, id: rule.id },
      });
      toast.success(rule.enabled ? "Rule disabled" : "Rule enabled");
      reload();
    } catch (toggleError) {
      toast.error(errorText(toggleError));
    }
  };

  const remove = async (rule: VaultExclusionRule) => {
    try {
      await accessRequest(`/api/resources/admin/vault-exclusions?id=${encodeURIComponent(rule.id)}`, {
        method: "DELETE",
      });
      toast.success("Exclusion rule deleted");
      if (editing === rule.id) reset();
      reload();
    } catch (removeError) {
      toast.error(errorText(removeError));
    }
  };

  if (!data) return <p className="text-sm text-fg-muted">Loading exclusion rules…</p>;
  if (!data.storeAvailable) return <StoreNotice message={data.message} />;

  return (
    <div className="space-y-6">
      <form onSubmit={save} className={PANEL_CLASS} aria-label={editing === null ? "New exclusion rule" : "Edit rule"}>
        <h3 className="text-sm font-bold text-fg-secondary">
          {editing === null ? "New exclusion rule" : "Edit exclusion rule"}
        </h3>
        <p className="text-xs text-fg-muted">
          Matching objects are hidden from every user, admins included, in lists and by name. Matching ignores case;
          regexes are unanchored and restricted (no backreferences, lookaround or nested repetition). The vault pattern
          is matched on the server against the vault the connection really reaches: for Azure Key Vault its name, host
          and URL; for HashiCorp Vault and OpenBao the endpoint host, URL and URL#namespace; for AWS the region and
          endpoint.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-vault-type">Vault type</Label>
            <select
              id="exclusion-vault-type"
              className={SELECT_CLASS}
              value={form.vaultType}
              onChange={(e) => change({ vaultType: e.target.value as VaultExclusionVaultType })}
            >
              <option value="any">Any vault</option>
              {VAULT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {RESOURCE_UI_CONFIG[type].label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-vault-pattern">Vault pattern</Label>
            <Input
              id="exclusion-vault-pattern"
              className="font-mono"
              placeholder="kv-prod-*"
              value={form.vaultPattern}
              onChange={(e) => change({ vaultPattern: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-vault-kind">Vault pattern kind</Label>
            <KindSelect
              id="exclusion-vault-kind"
              value={form.vaultPatternKind}
              onChange={(kind) => change({ vaultPatternKind: kind })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-object-type">Object type</Label>
            <select
              id="exclusion-object-type"
              className={SELECT_CLASS}
              value={form.objectType}
              onChange={(e) => change({ objectType: e.target.value as VaultExclusionObjectType })}
            >
              {(Object.keys(OBJECT_TYPE_LABEL) as VaultExclusionObjectType[]).map((type) => (
                <option key={type} value={type}>
                  {OBJECT_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-object-pattern">Object pattern</Label>
            <Input
              id="exclusion-object-pattern"
              className="font-mono"
              placeholder="break-glass-*"
              value={form.objectPattern}
              onChange={(e) => change({ objectPattern: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exclusion-object-kind">Object pattern kind</Label>
            <KindSelect
              id="exclusion-object-kind"
              value={form.objectPatternKind}
              onChange={(kind) => change({ objectPatternKind: kind })}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="exclusion-note">Note</Label>
            <Input id="exclusion-note" value={form.note} onChange={(e) => change({ note: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 self-end text-sm text-fg-secondary">
            <input type="checkbox" checked={form.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
            Enabled
          </label>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            <Plus className="h-3.5 w-3.5" />
            {editing === null ? "Add rule" : "Save rule"}
          </Button>
          {editing !== null && (
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </form>

      {data.rules.length === 0 ? (
        <p className="text-sm text-fg-muted">No exclusion rules: every vault shows everything its credentials allow.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline">
          <table className="w-full text-left text-sm" aria-label="Exclusion rules">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="p-3 font-medium">Vault</th>
                <th className="p-3 font-medium">Objects</th>
                <th className="p-3 font-medium">Enabled</th>
                <th className="p-3 font-medium">Note</th>
                <th className="p-3 font-medium">Updated</th>
                <th className="p-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id} data-testid="vault-exclusion-row" className="border-t border-hairline align-top">
                  <td className="p-3">
                    <div className="text-fg-secondary">{vaultTypeLabel(rule.vaultType)}</div>
                    <code className="font-mono text-fg">{rule.vaultPattern}</code>{" "}
                    <Badge variant="outline">{KIND_LABEL[rule.vaultPatternKind]}</Badge>
                  </td>
                  <td className="p-3">
                    <div className="text-fg-secondary">{OBJECT_TYPE_LABEL[rule.objectType]}</div>
                    <code className="font-mono text-fg">{rule.objectPattern}</code>{" "}
                    <Badge variant="outline">{KIND_LABEL[rule.objectPatternKind]}</Badge>
                  </td>
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`Enabled: ${rule.objectPattern} on ${rule.vaultPattern}`}
                      checked={rule.enabled}
                      onChange={() => void toggle(rule)}
                    />
                  </td>
                  <td className="p-3 text-fg-secondary">{rule.note}</td>
                  <td className="p-3 text-xs text-fg-muted">
                    {rule.updatedBy}
                    <br />
                    {rule.updatedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC")}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit rule ${rule.objectPattern} on ${rule.vaultPattern}`}
                        onClick={() => {
                          setForm(inputOf(rule));
                          setEditing(rule.id);
                          setError(null);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Delete rule ${rule.objectPattern} on ${rule.vaultPattern}`}
                        onClick={() => void remove(rule)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PreviewSection draft={form} />
    </div>
  );
}
