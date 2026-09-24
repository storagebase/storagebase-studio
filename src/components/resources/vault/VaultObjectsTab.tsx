"use client";

import { useCallback, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection, ResourceOperation } from "@/lib/resources/types";
import type { VaultObjectListing, VaultObjectSummary, VaultObjectType } from "@/lib/resources/operations";
import { ErrorLine, fieldClass, Loading, SectionTabs } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { CertificateImportForm } from "./CertificateImportForm";
import { KeyCreateForm } from "./KeyCreateForm";
import { SecretForm } from "./SecretForm";
import { VaultDeletedList } from "./VaultDeletedList";
import { VaultObjectDetail } from "./VaultObjectDetail";
import { formatDate, postVault, tagsText, TYPE_LABEL } from "./vault-api";

type View = "active" | "deleted";

/** The per-type columns: what a list row says beyond name, enabled and dates. */
function extraCells(object: VaultObjectSummary): string[] {
  if (object.type === "secret") return [object.contentType ?? "—"];
  if (object.type === "key") {
    return [object.keyType ?? "—", object.keySize !== null ? String(object.keySize) : (object.curve ?? "—")];
  }
  return [object.subject ?? "—", object.issuer ?? "—", object.thumbprint ?? "—"];
}

const EXTRA_HEADERS: Record<VaultObjectType, string[]> = {
  secret: ["Content type"],
  key: ["Type", "Size / curve"],
  certificate: ["Subject", "Issuer", "Thumbprint"],
};

/**
 * One tab (secrets, keys or certificates): the list with a client-side
 * filter on the left, the selected object's detail on the right, a create
 * form per type, and — where the vault soft-deletes — the Deleted view.
 */
export function VaultObjectsTab({
  connection,
  type,
  flags,
}: {
  connection: ResourceConnection;
  type: VaultObjectType;
  flags: ReadonlySet<ResourceOperation>;
}) {
  const read = useCallback(() => postVault<VaultObjectListing>(connection, "objects", { type }), [connection, type]);
  const { data: listing, error, reload } = useKafkaRead(read);
  const [view, setView] = useState<View>("active");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canCreate =
    (type === "secret" && flags.has("vault.secret.write")) ||
    (type === "key" && flags.has("vault.key.write")) ||
    (type === "certificate" && flags.has("vault.certificate.write"));

  const saved = (name: string) => {
    setCreating(false);
    setSelected(name);
    void reload();
  };

  const needle = filter.trim().toLowerCase();
  const visible = (listing?.objects ?? []).filter(
    (object) => object.name.toLowerCase().includes(needle) || tagsText(object.tags).toLowerCase().includes(needle),
  );

  const createForm =
    type === "secret" ? (
      <SecretForm
        connection={connection}
        withMetadata={flags.has("vault.secret.metadata")}
        onSaved={saved}
        onCancel={() => setCreating(false)}
      />
    ) : type === "key" ? (
      <KeyCreateForm connection={connection} onSaved={saved} onCancel={() => setCreating(false)} />
    ) : (
      <CertificateImportForm connection={connection} onSaved={saved} onCancel={() => setCreating(false)} />
    );

  return (
    <div data-testid={`vault-tab-${type}`} className="space-y-3">
      {flags.has("vault.soft-delete") && (
        <SectionTabs
          label={`${TYPE_LABEL[type]} views`}
          tabs={[
            { id: "active", label: TYPE_LABEL[type] },
            { id: "deleted", label: "Deleted items" },
          ]}
          active={view}
          onChange={setView}
        />
      )}
      {view === "deleted" ? (
        <VaultDeletedList connection={connection} type={type} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
          <div className="space-y-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Filter ${TYPE_LABEL[type].toLowerCase()}`}
                placeholder="Filter by name or tag"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className={`${fieldClass} w-56`}
              />
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => void reload()}>
                  <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
                  Refresh
                </Button>
                {canCreate && (
                  <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreating((open) => !open)}>
                    <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
                    {type === "certificate" ? "Import" : "Create"}
                  </Button>
                )}
              </div>
            </div>
            {creating && createForm}
            {error !== null && (
              <div className="flex items-center gap-2">
                <ErrorLine error={error} />
                <Button variant="outline" size="sm" className="text-xs" onClick={() => void reload()}>
                  Retry
                </Button>
              </div>
            )}
            {listing === null ? (
              error === null && <Loading label={`Listing ${TYPE_LABEL[type].toLowerCase()}…`} />
            ) : visible.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4">No {TYPE_LABEL[type].toLowerCase()} match.</p>
            ) : (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    {EXTRA_HEADERS[type].map((header) => (
                      <TableHead key={header}>{header}</TableHead>
                    ))}
                    <TableHead>Updated</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Tags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((object) => (
                    <TableRow
                      key={object.name}
                      data-testid="vault-object-row"
                      aria-selected={selected === object.name}
                      className={selected === object.name ? "bg-fill" : undefined}
                    >
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setSelected(object.name)}
                          className="font-medium text-fg hover:text-brand text-left break-all"
                        >
                          {object.name}
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className={object.enabled === false ? "text-warning" : "text-success"}>
                          {object.enabled === false ? "Disabled" : object.enabled === null ? "—" : "Enabled"}
                        </span>
                      </TableCell>
                      {extraCells(object).map((cell, index) => (
                        <TableCell key={EXTRA_HEADERS[type][index]} className="font-mono break-all">
                          {cell}
                        </TableCell>
                      ))}
                      <TableCell className="font-mono whitespace-nowrap">{formatDate(object.updatedOn)}</TableCell>
                      <TableCell className="font-mono whitespace-nowrap">
                        {formatDate(object.expiresOn, "Never")}
                      </TableCell>
                      <TableCell className="text-fg-subtle break-all">{tagsText(object.tags) || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {listing?.truncated && <p className="text-xs text-fg-subtle">Only the first page of objects is listed.</p>}
          </div>
          <div className="min-w-0">
            {selected === null ? (
              <p className="text-xs text-muted-foreground py-4">Select an object to see its details.</p>
            ) : (
              <VaultObjectDetail
                key={selected}
                connection={connection}
                type={type}
                name={selected}
                flags={flags}
                onChanged={() => void reload()}
                onDeleted={() => {
                  setSelected(null);
                  void reload();
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
