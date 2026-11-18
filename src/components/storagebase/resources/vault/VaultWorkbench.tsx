"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { VAULT_OBJECT_TYPES, type VaultObjectType } from "@/storagebase/resources/operations";
import type { ResourceConnection, ResourceOperation } from "@/storagebase/resources/types";
import { ErrorLine, Loading, SectionTabs } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { VaultObjectsTab } from "./VaultObjectsTab";
import { readVaultFlags, TYPE_FLAG, TYPE_LABEL } from "./vault-api";

/**
 * Every write a vault declares. A read-only connection (a seeded one granted
 * read) gets the provider's flags without these, so the tabs, forms and
 * detail read exactly what a service that cannot write would show — Reveal
 * is a read and stays.
 */
const WRITE_FLAGS: ReadonlySet<ResourceOperation> = new Set<ResourceOperation>([
  "vault.secret.write",
  "vault.key.write",
  "vault.certificate.write",
  "vault.delete",
]);

/**
 * The vault workbench — what every vault connection opens full-page on the
 * Vaults page (Azure Key Vault now; HashiCorp Vault / OpenBao in phase 6).
 * Tabs are the object types the provider declares (`vault.secrets`,
 * `vault.keys`, `vault.certificates`), so a service without keys shows no
 * Keys tab rather than an empty one. The page header names the connection;
 * this owns everything below it.
 *
 * Keyed by connection id on the page, so switching vaults starts clean.
 * (The legacy workbench also rendered an admin exclusions notice here; the
 * access model it belonged to is gone — decision D3 — and with it the notice
 * and the `isAdmin` prop that gated it.)
 */
export function VaultWorkbench({
  connection,
  readOnly = false,
}: {
  connection: ResourceConnection;
  readOnly?: boolean;
}) {
  const read = useCallback(async () => {
    const declared = await readVaultFlags(connection);
    return readOnly ? new Set([...declared].filter((flag) => !WRITE_FLAGS.has(flag))) : declared;
  }, [connection, readOnly]);
  const { data: flags, error, reload } = useKafkaRead(read);
  const [chosen, setChosen] = useState<VaultObjectType | null>(null);

  const types = VAULT_OBJECT_TYPES.filter((type) => flags?.has(TYPE_FLAG[type]));
  const active = chosen ?? types[0];

  return (
    <div data-testid="vault-workbench" className="h-full overflow-auto bg-surface text-fg p-4 space-y-4">
      {flags === null ? (
        error === null ? (
          <Loading label="Reading the vault…" />
        ) : (
          <div className="flex items-center gap-2">
            <ErrorLine error={error} />
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )
      ) : active === undefined ? (
        <p className="text-xs text-muted-foreground">This vault declares no browsable objects.</p>
      ) : (
        <>
          <SectionTabs
            label="Vault object types"
            tabs={types.map((type) => ({ id: type, label: TYPE_LABEL[type] }))}
            active={active}
            onChange={setChosen}
          />
          <VaultObjectsTab key={active} connection={connection} type={active} flags={flags} readOnly={readOnly} />
        </>
      )}
    </div>
  );
}
