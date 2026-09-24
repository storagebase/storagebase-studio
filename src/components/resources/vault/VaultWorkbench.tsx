"use client";

import React, { useCallback, useState } from "react";
import { Pencil, ShieldOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getResourceIcon, RESOURCE_UI_CONFIG } from "@/lib/resources/ui-config";
import { VAULT_OBJECT_TYPES, type VaultObjectType } from "@/lib/resources/operations";
import type { ResourceConnection } from "@/lib/resources/types";
import { ErrorLine, Loading, SectionTabs } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { VaultExclusionsPanel } from "./VaultExclusionsPanel";
import { VaultObjectsTab } from "./VaultObjectsTab";
import { readVaultFlags, TYPE_FLAG, TYPE_LABEL } from "./vault-api";

/**
 * The vault workbench — what selecting a vault connection opens in the main
 * area (Azure Key Vault, HashiCorp Vault / OpenBao, AWS Secrets Manager, AWS
 * KMS). Tabs are the object types the provider declares (`vault.secrets`,
 * `vault.keys`, `vault.certificates`), so a service without keys shows no
 * Keys tab rather than an empty one. Admins get the exclusions panel.
 *
 * Keyed by connection id in the shell, so switching vaults starts clean.
 */
export function VaultWorkbench({
  connection,
  isAdmin,
  onClose,
  onEditConnection,
}: {
  connection: ResourceConnection;
  isAdmin: boolean;
  onClose: () => void;
  onEditConnection?: (connection: ResourceConnection) => void;
}) {
  const read = useCallback(() => readVaultFlags(connection), [connection]);
  const { data: flags, error, reload } = useKafkaRead(read);
  const [chosen, setChosen] = useState<VaultObjectType | null>(null);
  const [settings, setSettings] = useState(false);

  const types = VAULT_OBJECT_TYPES.filter((type) => flags?.has(TYPE_FLAG[type]));
  const active = chosen ?? types[0];

  return (
    <div data-testid="vault-workbench" className="h-full flex flex-col bg-surface text-fg">
      <header className="h-12 px-4 flex items-center gap-2 border-b border-hairline shrink-0">
        {React.createElement(getResourceIcon(connection.type), {
          className: `w-4 h-4 ${RESOURCE_UI_CONFIG[connection.type].color}`,
        })}
        <span className="text-sm font-medium truncate">{connection.name}</span>
        <span className="text-xs text-fg-subtle truncate">{RESOURCE_UI_CONFIG[connection.type].label}</span>
        <div className="ml-auto flex items-center gap-1">
          {isAdmin && (
            <Button
              variant={settings ? "outline" : "ghost"}
              size="sm"
              className="text-xs"
              aria-pressed={settings}
              onClick={() => setSettings((open) => !open)}
            >
              <ShieldOff strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Exclusions
            </Button>
          )}
          {onEditConnection && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              aria-label="Edit connection"
              onClick={() => onEditConnection(connection)}
            >
              <Pencil strokeWidth={1.5} className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-xs" aria-label="Close workbench" onClick={onClose}>
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </Button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        {settings && <VaultExclusionsPanel connection={connection} />}
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
            <VaultObjectsTab key={active} connection={connection} type={active} flags={flags} />
          </>
        )}
      </div>
    </div>
  );
}
