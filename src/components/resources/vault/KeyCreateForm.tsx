"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ResourceConnection } from "@/lib/resources/types";
import { errorText, parseKeyValueLines } from "../kafka/kafka-api";
import { ErrorLine, fieldClass, selectClass, textareaClass } from "../kafka/parts";
import { localToIso, postVault } from "./vault-api";

const KEY_SPECS = [
  { id: "RSA-2048", label: "RSA 2048", body: { keyType: "RSA", keySize: 2048 } },
  { id: "RSA-3072", label: "RSA 3072", body: { keyType: "RSA", keySize: 3072 } },
  { id: "RSA-4096", label: "RSA 4096", body: { keyType: "RSA", keySize: 4096 } },
  { id: "EC-P-256", label: "EC P-256", body: { keyType: "EC", curve: "P-256" } },
  { id: "EC-P-384", label: "EC P-384", body: { keyType: "EC", curve: "P-384" } },
  { id: "EC-P-521", label: "EC P-521", body: { keyType: "EC", curve: "P-521" } },
] as const;

/** Create an RSA or EC key: name, type/size or curve, expiry, tags, enabled. */
export function KeyCreateForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection: ResourceConnection;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [spec, setSpec] = useState<(typeof KEY_SPECS)[number]["id"]>("RSA-2048");
  const [expires, setExpires] = useState("");
  const [tagText, setTagText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const tags = parseKeyValueLines(tagText);
    if (typeof tags === "string") {
      setError(`Tags: ${tags}`);
      return;
    }
    setError(null);
    try {
      const expiresOn = localToIso(expires);
      await postVault(connection, "key/create", {
        name: name.trim(),
        ...(KEY_SPECS.find((entry) => entry.id === spec) as (typeof KEY_SPECS)[number]).body,
        ...(Object.keys(tags).length === 0 ? {} : { tags }),
        ...(expiresOn === undefined ? {} : { expiresOn }),
        enabled,
      });
      onSaved(name.trim());
    } catch (createError) {
      setError(errorText(createError));
    }
  };

  return (
    <div data-testid="vault-key-form" className="rounded-md border border-hairline bg-panel p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="vault-key-name" className="text-xs text-fg-muted">
            Name
          </Label>
          <Input id="vault-key-name" value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vault-key-spec" className="text-xs text-fg-muted">
            Type
          </Label>
          <select
            id="vault-key-spec"
            value={spec}
            onChange={(e) => setSpec(e.target.value as typeof spec)}
            className={`${selectClass} w-full`}
          >
            {KEY_SPECS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vault-key-expires" className="text-xs text-fg-muted">
            Expires
          </Label>
          <Input
            id="vault-key-expires"
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            className={fieldClass}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted self-end">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="col-span-2 space-y-1">
          <Label htmlFor="vault-key-tags" className="text-xs text-fg-muted">
            Tags (name=value per line)
          </Label>
          <textarea
            id="vault-key-tags"
            rows={2}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            className={textareaClass}
          />
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <Button size="sm" className="text-xs" disabled={name.trim() === ""} onClick={() => void create()}>
          Create key
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
