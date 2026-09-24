"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ResourceConnection } from "@/lib/resources/types";
import { errorText, parseKeyValueLines } from "../kafka/kafka-api";
import { ErrorLine, fieldClass, textareaClass } from "../kafka/parts";
import { postVault } from "./vault-api";

/** The upload bound, mirrored from the route (1 MiB decoded) so an oversize file is refused before it is read. */
export const CERTIFICATE_MAX_BYTES = 1024 * 1024;

const PKCS12 = /\.(pfx|p12)$/i;
const PEM = /\.(pem|cer|crt)$/i;

/** Browser-side base64 of a file's bytes, chunked so a 1 MiB file does not blow the call stack. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Import a certificate: PEM/CER/CRT or PFX/P12 (by extension), optional
 * password, bounded size. The password field is never pre-filled and is
 * cleared on success.
 */
export function CertificateImportForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection: ResourceConnection;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const importFile = async () => {
    const chosen = file as File;
    const format = PKCS12.test(chosen.name) ? "pkcs12" : PEM.test(chosen.name) ? "pem" : null;
    if (format === null) {
      setError("Choose a .pem, .cer, .crt, .pfx or .p12 file.");
      return;
    }
    if (chosen.size > CERTIFICATE_MAX_BYTES) {
      setError("Certificate files are at most 1024 KiB.");
      return;
    }
    const tags = parseKeyValueLines(tagText);
    if (typeof tags === "string") {
      setError(`Tags: ${tags}`);
      return;
    }
    setError(null);
    try {
      await postVault(connection, "certificate/import", {
        name: name.trim(),
        contentsBase64: await fileToBase64(chosen),
        format,
        ...(password === "" ? {} : { password }),
        ...(Object.keys(tags).length === 0 ? {} : { tags }),
      });
      setPassword("");
      onSaved(name.trim());
    } catch (importError) {
      setError(errorText(importError));
    }
  };

  return (
    <div data-testid="vault-certificate-form" className="rounded-md border border-hairline bg-panel p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="vault-certificate-name" className="text-xs text-fg-muted">
            Name
          </Label>
          <Input
            id="vault-certificate-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vault-certificate-password" className="text-xs text-fg-muted">
            Password (PFX/P12, optional)
          </Label>
          <Input
            id="vault-certificate-password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="col-span-2 space-y-1">
          <Label htmlFor="vault-certificate-file" className="text-xs text-fg-muted">
            Certificate file
          </Label>
          <input
            id="vault-certificate-file"
            type="file"
            accept=".pem,.cer,.crt,.pfx,.p12"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <Label htmlFor="vault-certificate-tags" className="text-xs text-fg-muted">
            Tags (name=value per line)
          </Label>
          <textarea
            id="vault-certificate-tags"
            rows={2}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            className={textareaClass}
          />
        </div>
      </div>
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <Button
          size="sm"
          className="text-xs"
          disabled={name.trim() === "" || file === null}
          onClick={() => void importFile()}
        >
          Import
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
