"use client";

import { useCallback, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceConnection } from "@/lib/resources/types";
import {
  normalizedVaultAddress,
  type VaultExclusionKind,
  type VaultExclusionObjectType,
  type VaultExclusionRule,
} from "@/lib/resources/vault-exclusions";
import { errorText } from "../kafka/kafka-api";
import { ErrorLine, fieldClass, Loading, Notice, selectClass } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { sendJson } from "./vault-api";

type Counts = Record<string, { total: number; hidden: number }>;

const BLANK_RULE: VaultExclusionRule = { pattern: "", kind: "glob", objectType: "any", note: "" };

/**
 * Admin-only: this vault's exclusion rules. The server enforces them on every
 * vault route for everyone, admins included; this panel edits the list, and
 * Preview asks the server how many objects a draft would hide (counts only —
 * the server never sends the hidden names back).
 */
export function VaultExclusionsPanel({ connection }: { connection: ResourceConnection }) {
  const query = new URLSearchParams({ type: connection.type, address: normalizedVaultAddress(connection) });
  const endpoint = `/api/resources/admin/vault-exclusions?${query.toString()}`;
  const read = useCallback(() => sendJson<{ rules: VaultExclusionRule[] }>(endpoint, "GET"), [endpoint]);
  const { data, error: readError } = useKafkaRead(read);
  const [draft, setDraft] = useState<VaultExclusionRule[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rules = draft ?? data?.rules ?? [];

  const update = (index: number, change: Partial<VaultExclusionRule>) => {
    setDraft(rules.map((rule, position) => (position === index ? { ...rule, ...change } : rule)));
    setCounts(null);
  };

  const preview = async () => {
    setError(null);
    try {
      setCounts(
        (
          await sendJson<{ counts: Counts }>("/api/resources/admin/vault-exclusions/preview", "POST", {
            connection,
            rules,
          })
        ).counts,
      );
    } catch (previewError) {
      setError(errorText(previewError));
    }
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      const saved = await sendJson<{ rules: VaultExclusionRule[] }>("/api/resources/admin/vault-exclusions", "PUT", {
        type: connection.type,
        address: normalizedVaultAddress(connection),
        rules,
      });
      setDraft(saved.rules);
      setNotice("Exclusion rules saved. They apply to everyone, on every vault view.");
    } catch (saveError) {
      setError(errorText(saveError));
    }
  };

  return (
    <section data-testid="vault-exclusions" className="rounded-md border border-hairline bg-panel p-3 space-y-3">
      <div>
        <h3 className="text-xs font-medium text-fg">Vault exclusions (admin)</h3>
        <p className="text-xs text-fg-subtle leading-relaxed">
          Objects matching a rule are hidden from every user, admins included, in lists and by name. Globs use * and ?;
          regexes are unanchored and restricted (no backreferences, lookaround or nested repetition).
        </p>
      </div>
      <ErrorLine error={error ?? readError} />
      <Notice notice={notice} />
      {data === null && readError === null ? (
        <Loading label="Reading the rules…" />
      ) : (
        <div className="space-y-2">
          {rules.length === 0 && <p className="text-xs text-muted-foreground">No rules: nothing is hidden.</p>}
          {rules.map((rule, index) => (
            <div key={index} data-testid="vault-exclusion-rule" className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Rule ${index + 1} pattern`}
                value={rule.pattern}
                onChange={(e) => update(index, { pattern: e.target.value })}
                className={`${fieldClass} w-56 font-mono`}
              />
              <select
                aria-label={`Rule ${index + 1} kind`}
                value={rule.kind}
                onChange={(e) => update(index, { kind: e.target.value as VaultExclusionKind })}
                className={selectClass}
              >
                <option value="exact">Exact</option>
                <option value="glob">Glob</option>
                <option value="regex">Regex</option>
              </select>
              <select
                aria-label={`Rule ${index + 1} object type`}
                value={rule.objectType}
                onChange={(e) => update(index, { objectType: e.target.value as VaultExclusionObjectType })}
                className={selectClass}
              >
                <option value="any">Any object</option>
                <option value="secret">Secrets</option>
                <option value="key">Keys</option>
                <option value="certificate">Certificates</option>
              </select>
              <Input
                aria-label={`Rule ${index + 1} note`}
                placeholder="Note"
                value={rule.note}
                onChange={(e) => update(index, { note: e.target.value })}
                className={`${fieldClass} w-48`}
              />
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => {
                  setDraft(rules.filter((_, position) => position !== index));
                  setCounts(null);
                }}
              >
                <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => {
                setDraft([...rules, BLANK_RULE]);
                setCounts(null);
              }}
            >
              <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Add rule
            </Button>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void preview()}>
              Preview
            </Button>
            <Button size="sm" className="text-xs" onClick={() => void save()}>
              Save rules
            </Button>
          </div>
          {counts !== null && (
            <ul data-testid="vault-exclusion-preview" className="text-xs text-fg-secondary">
              {Object.entries(counts).map(([type, count]) => (
                <li key={type}>
                  Would hide {count.hidden} of {count.total} {type}s
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
