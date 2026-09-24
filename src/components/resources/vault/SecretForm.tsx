"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ResourceConnection } from "@/lib/resources/types";
import { errorText, parseKeyValueLines } from "../kafka/kafka-api";
import { ErrorLine, fieldClass, textareaClass } from "../kafka/parts";
import { localToIso, postVault } from "./vault-api";

/**
 * Create a secret, or edit one. EVERY field starts empty, the value above all:
 * the form never holds plaintext it did not receive from the keyboard. On an
 * edit, an empty value means "properties only" (the current version keeps
 * its value, which is never read); a typed value adds a new version.
 * `withMetadata` is the provider's `vault.secret.metadata` flag: without it,
 * only a value can be saved.
 */
export function SecretForm({
  connection,
  existingName,
  withMetadata,
  onSaved,
  onCancel,
}: {
  connection: ResourceConnection;
  /** Absent: create. */
  existingName?: string;
  withMetadata: boolean;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [contentType, setContentType] = useState("");
  const [tagText, setTagText] = useState("");
  const [expires, setExpires] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = existingName ?? name.trim();

  const save = async () => {
    const tags = parseKeyValueLines(tagText);
    if (typeof tags === "string") {
      setError(`Tags: ${tags}`);
      return;
    }
    if (value === "" && (existingName === undefined || !withMetadata)) {
      setError("Enter a value.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const expiresOn = localToIso(expires);
      await postVault(connection, "secret/save", {
        name: target,
        ...(value === "" ? {} : { value }),
        ...(withMetadata
          ? {
              ...(contentType === "" ? {} : { contentType }),
              ...(Object.keys(tags).length === 0 ? {} : { tags }),
              ...(expiresOn === undefined ? {} : { expiresOn }),
              enabled,
            }
          : {}),
      });
      setValue("");
      onSaved(target);
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="vault-secret-form" className="rounded-md border border-hairline bg-panel p-3 space-y-2">
      {existingName === undefined && (
        <div className="space-y-1">
          <Label htmlFor="vault-secret-name" className="text-xs text-fg-muted">
            Name
          </Label>
          <Input id="vault-secret-name" value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="vault-secret-value-input" className="text-xs text-fg-muted">
          {existingName === undefined ? "Value" : "New value (empty keeps the current value)"}
        </Label>
        <textarea
          id="vault-secret-value-input"
          rows={3}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          className={textareaClass}
        />
      </div>
      {withMetadata && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="vault-secret-content-type" className="text-xs text-fg-muted">
              Content type
            </Label>
            <Input
              id="vault-secret-content-type"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vault-secret-expires" className="text-xs text-fg-muted">
              Expires
            </Label>
            <Input
              id="vault-secret-expires"
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="vault-secret-tags" className="text-xs text-fg-muted">
              Tags (name=value per line)
            </Label>
            <textarea
              id="vault-secret-tags"
              rows={2}
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              className={textareaClass}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
      )}
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <Button size="sm" className="text-xs" disabled={busy || target === ""} onClick={() => void save()}>
          Save
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
