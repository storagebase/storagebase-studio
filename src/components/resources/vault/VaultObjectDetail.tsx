"use client";

import { useCallback, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection, ResourceOperation } from "@/lib/resources/types";
import type { VaultObjectDetail as Detail, VaultObjectType } from "@/lib/resources/operations";
import { errorText } from "../kafka/kafka-api";
import { ConfirmByName, ErrorLine, Loading } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { SecretForm } from "./SecretForm";
import { SecretValue } from "./SecretValue";
import { formatDate, postVault, tagsText } from "./vault-api";

/**
 * One object: every piece of metadata the provider has, the version history,
 * and — for secrets — the masked value with Reveal, and Edit (an empty form).
 * Delete follows the vault's semantics: a soft delete (recoverable from the
 * Deleted view) is one confirm; a permanent one asks for the typed name.
 */
export function VaultObjectDetail({
  connection,
  type,
  name,
  flags,
  onChanged,
  onDeleted,
}: {
  connection: ResourceConnection;
  type: VaultObjectType;
  name: string;
  flags: ReadonlySet<ResourceOperation>;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const read = useCallback(() => postVault<Detail>(connection, "object", { type, name }), [connection, type, name]);
  const { data: detail, error: readError, reload } = useKafkaRead(read);
  const [editing, setEditing] = useState(false);
  const [confirmSoft, setConfirmSoft] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const softDelete = flags.has("vault.soft-delete");

  const remove = async () => {
    setWriteError(null);
    try {
      await postVault(connection, "object/delete", { type, name });
      onDeleted();
    } catch (deleteError) {
      setWriteError(errorText(deleteError));
    }
  };

  if (detail === null) {
    return readError === null ? <Loading label="Reading…" /> : <ErrorLine error={readError} />;
  }

  const rows: Array<[string, string]> = [
    ["Enabled", detail.enabled === null ? "—" : detail.enabled ? "Yes" : "No"],
    ...(type === "secret" ? ([["Content type", detail.contentType ?? "—"]] as Array<[string, string]>) : []),
    ...(type === "key"
      ? ([
          ["Key type", detail.keyType ?? "—"],
          ["Size / curve", detail.keySize !== null ? `${detail.keySize} bits` : (detail.curve ?? "—")],
          ["Permitted operations", detail.keyOperations.join(", ") || "—"],
        ] as Array<[string, string]>)
      : []),
    ...(type === "certificate"
      ? ([
          ["Subject", detail.subject ?? "—"],
          ["Issuer", detail.issuer ?? "—"],
          ["Thumbprint", detail.thumbprint ?? "—"],
        ] as Array<[string, string]>)
      : []),
    ["Created", formatDate(detail.createdOn)],
    ["Updated", formatDate(detail.updatedOn)],
    ["Expires", formatDate(detail.expiresOn, "Never")],
    ["Not before", formatDate(detail.notBefore)],
    ["Tags", tagsText(detail.tags) || "—"],
    ["Version", detail.version ?? "—"],
    ["Recovery level", detail.recoveryLevel ?? "—"],
  ];

  return (
    <div data-testid="vault-object-detail" className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-fg break-all">{name}</h2>
        <div className="ml-auto flex gap-2">
          {type === "secret" && flags.has("vault.secret.write") && (
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setEditing((open) => !open)}>
              <Pencil strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Edit
            </Button>
          )}
        </div>
      </div>
      <ErrorLine error={readError ?? writeError} />

      {type === "secret" && flags.has("vault.secret.reveal") && <SecretValue connection={connection} name={name} />}
      {editing && (
        <SecretForm
          connection={connection}
          existingName={name}
          withMetadata={flags.has("vault.secret.metadata")}
          onSaved={() => {
            setEditing(false);
            void reload();
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="font-mono text-fg break-all">{value}</dd>
          </div>
        ))}
      </dl>

      {detail.versions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-fg-muted">
            Versions ({detail.versions.length}
            {detail.versionsTruncated ? "+" : ""})
          </h3>
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.versions.map((version) => (
                <TableRow key={version.version} data-testid="vault-version-row">
                  <TableCell className="font-mono break-all">{version.version}</TableCell>
                  <TableCell>{version.enabled === false ? "No" : "Yes"}</TableCell>
                  <TableCell className="font-mono">{formatDate(version.createdOn)}</TableCell>
                  <TableCell className="font-mono">{formatDate(version.expiresOn, "Never")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {flags.has("vault.delete") &&
        (softDelete ? (
          confirmSoft ? (
            <div className="rounded-md border border-danger-tint/40 bg-panel p-3 space-y-2 max-w-md">
              <p className="text-xs text-fg-secondary">
                Delete {name}? It moves to Deleted items, where it can be recovered until its purge date.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="text-xs text-danger" onClick={() => void remove()}>
                  Delete
                </Button>
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setConfirmSoft(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="text-xs text-danger" onClick={() => setConfirmSoft(true)}>
              <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Delete
            </Button>
          )
        ) : (
          <ConfirmByName
            name={name}
            action="Delete"
            consequence="This vault has no soft delete: deleting permanently removes the object and cannot be undone."
            onConfirm={remove}
          />
        ))}
    </div>
  );
}
