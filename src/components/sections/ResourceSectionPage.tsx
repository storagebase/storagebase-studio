"use client";

// Family provider registration (client side): a section page composes the
// build's families, so the form's offers match what the server answers.
// Presentational components never import this barrel — unit tests start from
// an empty registry and register fakes explicitly, and the embedded workspace
// (which carries no routes) must never offer tiles that would answer 501.
import "@/lib/resources/providers";

import { useState } from "react";
import { MousePointerClick, Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ResourceTree } from "@/components/resources/ResourceTree";
import { ResourceViewerPane } from "@/components/resources/ResourceViewerPane";
import { KafkaWorkbench } from "@/components/resources/kafka";
import { VaultWorkbench } from "@/components/resources/vault";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useResourceHealth } from "@/hooks/use-resource-health";
import { useResourceSection } from "@/hooks/use-resource-section";
import { useStorageSync } from "@/hooks/use-storage-sync";
import { newLocalId } from "@/lib/ids";
import { opensWorkbench } from "@/lib/resources/ui-config";
import {
  isReadOnlyResourceConnection,
  type ResourceCategory,
  type ResourceConnection,
  type ResourceNode,
} from "@/lib/resources/types";
import { cn } from "@/lib/utils";
import { ResourceConnectionDialog } from "./ResourceConnectionDialog";
import { SectionConnectionList } from "./SectionConnectionList";
import { SectionHeader } from "./SectionHeader";
import { sectionById } from "./sections";

/**
 * One resource management page — Blob storage, Messaging or Vaults — with its
 * own connection list, header and main area (StorageBase fork). The Databases
 * page is the upstream studio; nothing here reaches into it, and it shows
 * nothing of this.
 *
 * What the main area holds follows the active connection's type: a workbench
 * type (Kafka, every vault) opens its workbench full-page; the others (the
 * blob types, RabbitMQ, SQS) list a tree under the connections, and a tree row
 * opens its viewer full-page beside it.
 *
 * Below the breakpoint the page is master/detail: the list (with the tree),
 * or the detail with a back button in the header. Both stay mounted and only
 * one is shown, so going back keeps the tree as it was.
 */
export function ResourceSectionPage({
  category,
  initialConnectionId = null,
}: {
  category: ResourceCategory;
  /** The `?connection=<id>` deep link, read by the route. */
  initialConnectionId?: string | null;
}) {
  const section = sectionById(category);
  const { user, isAdmin, handleLogout } = useAuth();
  const { isReady: storageReady } = useStorageSync();
  const res = useResourceSection(category, storageReady, initialConnectionId);
  const active = res.active;
  const health = useResourceHealth(active);
  const isMobile = useIsMobile();
  const readOnly = active !== null && isReadOnlyResourceConnection(active);
  const workbench = active !== null && opensWorkbench(active.type);

  const [dialog, setDialog] = useState<{ open: boolean; edit: ResourceConnection | null }>({
    open: false,
    edit: null,
  });
  const [pendingDelete, setPendingDelete] = useState<ResourceConnection | null>(null);
  // The tree row on show, kept beside its connection so another connection never inherits it.
  const [picked, setPicked] = useState<{ connectionId: string; node: ResourceNode } | null>(null);
  const node = active !== null && picked?.connectionId === active.id ? picked.node : null;
  const [refreshToken, setRefreshToken] = useState(0);
  const [showDetail, setShowDetail] = useState(false);

  const closeDialog = () => setDialog({ open: false, edit: null });
  const duplicate = (conn: ResourceConnection) =>
    setDialog({
      open: true,
      edit: {
        ...structuredClone(conn),
        id: newLocalId(),
        name: `${conn.name} (copy)`,
        createdAt: new Date().toISOString(),
        // A copy is a NEW connection: the server holds no secret for it yet, so it is re-entered.
        savedSecrets: undefined,
      },
    });

  const selectConnection = (conn: ResourceConnection) => {
    res.select(conn);
    if (opensWorkbench(conn.type)) setShowDetail(true);
  };

  const selectNode = (next: ResourceNode) => {
    if (active === null) return;
    setPicked({ connectionId: active.id, node: next });
    // A container expands in place; a leaf is what there is to look at.
    if (!next.hasChildren) setShowDetail(true);
  };

  const list = (
    <div data-testid="section-sidebar" className="flex h-full min-h-0 flex-col">
      <div className="h-12 shrink-0 px-3 flex items-center gap-2 border-b border-hairline">
        <section.icon strokeWidth={1.5} className="w-3.5 h-3.5 text-brand" />
        <h2 className="text-xs font-medium text-fg">{section.label}</h2>
        <button
          type="button"
          onClick={() => setDialog({ open: true, edit: null })}
          aria-label={`Add ${section.connectionNoun} connection`}
          title={`Add ${section.connectionNoun} connection`}
          className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-tint/50"
        >
          <Plus strokeWidth={1.5} className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-4">
        <SectionConnectionList
          connections={res.connections}
          activeId={active?.id ?? null}
          noun={section.connectionNoun}
          onSelect={selectConnection}
          onEdit={(conn) => setDialog({ open: true, edit: conn })}
          onDuplicate={duplicate}
          onDelete={setPendingDelete}
          onAdd={() => setDialog({ open: true, edit: null })}
          managedLoading={res.managedLoading}
          managedError={res.managedError}
        />
        {active !== null && !workbench && (
          <section aria-label={`${active.name} contents`} className="space-y-1">
            <h3 className="px-2 text-xs font-medium text-muted-foreground truncate">{active.name}</h3>
            <ResourceTree key={active.id} connection={active} onNodeClick={selectNode} refreshToken={refreshToken} />
            {isMobile && node?.hasChildren && (
              <Button variant="outline" size="sm" className="w-full text-xs" onClick={() => setShowDetail(true)}>
                Open {node.name}
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );

  const detail =
    active === null ? (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center text-fg-muted">
        <section.icon strokeWidth={1.5} className="w-10 h-10 opacity-30" />
        <p className="text-xs">Add a {section.connectionNoun} connection to get started.</p>
        <Button size="sm" className="text-xs" onClick={() => setDialog({ open: true, edit: null })}>
          <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Add connection
        </Button>
      </div>
    ) : workbench ? (
      category === "vault" ? (
        <VaultWorkbench key={active.id} connection={active} isAdmin={isAdmin} readOnly={readOnly} />
      ) : (
        <KafkaWorkbench key={active.id} connection={active} readOnly={readOnly} />
      )
    ) : node !== null ? (
      <ResourceViewerPane
        key={`${active.id}:${node.id}`}
        connection={active}
        node={node}
        readOnly={readOnly}
        onChanged={() => setRefreshToken((token) => token + 1)}
        onClose={() => {
          setPicked(null);
          setShowDetail(false);
        }}
      />
    ) : (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center text-fg-muted">
        <MousePointerClick strokeWidth={1.5} className="w-10 h-10 opacity-30" />
        <p className="text-xs">Select an item in the tree to browse it.</p>
      </div>
    );

  return (
    <div data-testid={`resource-section-${category}`} className="flex h-full w-full overflow-hidden bg-surface text-fg">
      {!isMobile && <aside className="w-72 shrink-0 border-r border-hairline bg-card/50">{list}</aside>}
      <div className="flex-1 min-w-0 flex flex-col">
        <SectionHeader
          section={section}
          connection={active}
          health={health}
          user={user}
          isAdmin={isAdmin}
          onLogout={handleLogout}
          onEdit={(conn) => setDialog({ open: true, edit: conn })}
          onBack={isMobile && showDetail ? () => setShowDetail(false) : undefined}
        />
        <main className="flex-1 min-h-0 overflow-hidden">
          {isMobile ? (
            <>
              <div className={cn("h-full", showDetail && "hidden")}>{list}</div>
              <div className={cn("h-full", !showDetail && "hidden")}>{detail}</div>
            </>
          ) : (
            detail
          )}
        </main>
      </div>

      <ResourceConnectionDialog
        category={category}
        isOpen={dialog.open}
        onClose={closeDialog}
        editConnection={dialog.edit}
        onConnect={(conn) => {
          res.save(conn);
          closeDialog();
          if (opensWorkbench(conn.type)) setShowDetail(true);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 strokeWidth={1.5} className="w-5 h-5 text-danger" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-[0.8125rem] font-medium text-fg mb-1">
                  Delete connection?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-fg-muted leading-relaxed">
                  <span className="text-fg-tertiary">{pendingDelete?.name}</span> will be removed. This cannot be
                  undone.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-fill border-0 text-fg-tertiary text-xs font-medium hover:bg-fill-strong hover:text-fg">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) res.remove(pendingDelete.id);
                setPendingDelete(null);
              }}
              className="flex-1 h-9 bg-danger-solid border-0 text-white text-xs font-medium hover:bg-danger-solid-hover"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
