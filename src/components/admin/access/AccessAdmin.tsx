"use client";

import { useSearchParams } from "next/navigation";
import { Eye, FolderTree, KeyRound, LogIn, Plug, ShieldOff } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthPanel } from "./AuthPanel";
import { BindingsPanel } from "./BindingsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { GroupsPanel } from "./GroupsPanel";
import { PreviewPanel } from "./PreviewPanel";
import { VaultExclusionsPanel } from "./VaultExclusionsPanel";

/**
 * Admin > Access (StorageBase fork): connection groups, the app-role bindings that grant them,
 * the managed connections inside them, the sign-in switch, a preview of what a set of app
 * roles yields, and the global vault exclusion rules (whose API is /api/resources/admin). Every change goes through the admin-only API under /api/admin/access and is
 * audited there. See docs/ENTRA.md.
 */

const TRIGGER_CLASS =
  "gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-brand text-fg-muted text-xs px-4";

const TABS = [
  { value: "groups", label: "Groups", icon: FolderTree },
  { value: "bindings", label: "Role bindings", icon: KeyRound },
  { value: "connections", label: "Managed connections", icon: Plug },
  { value: "authentication", label: "Authentication", icon: LogIn },
  { value: "preview", label: "Access preview", icon: Eye },
  { value: "vault-exclusions", label: "Vault exclusions", icon: ShieldOff },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export function AccessAdmin() {
  const params = useSearchParams();
  // Back from a test sign-in with Microsoft: land on the tab that shows its result. A link may
  // also name a tab (`?tab=vault-exclusions`, from the vault workbench).
  const named = TABS.find((tab) => tab.value === params.get("tab"))?.value;
  const initial: TabValue = params.get("entraTest") !== null ? "authentication" : (named ?? "groups");
  return (
    <div className="space-y-6">
      <Tabs defaultValue={initial}>
        <TabsList className="bg-transparent border-b border-hairline rounded-none p-0 h-10 w-full justify-start overflow-x-auto">
          {TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className={TRIGGER_CLASS}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="groups" className="mt-4">
          <GroupsPanel />
        </TabsContent>
        <TabsContent value="bindings" className="mt-4">
          <BindingsPanel />
        </TabsContent>
        <TabsContent value="connections" className="mt-4">
          <ConnectionsPanel />
        </TabsContent>
        <TabsContent value="authentication" className="mt-4">
          <AuthPanel />
        </TabsContent>
        <TabsContent value="preview" className="mt-4">
          <PreviewPanel />
        </TabsContent>
        <TabsContent value="vault-exclusions" className="mt-4">
          <VaultExclusionsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
