"use client";

import React from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { getResourceViewer } from "@/components/resources/viewer-registry";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

// Family viewer barrels land here, one import per family with a viewer. The
// import is for effect (self-registration); the inspector reads viewers
// through the registry, and the registry test pins every type to one.
import "@/components/resources/blob";
import "@/components/resources/messaging";
import "@/components/resources/vaults";

/**
 * The resource inspector: what a tree row opens. Renders the family's viewer
 * for the connection's type, or an honest fallback for types with no viewer
 * yet (messaging and vault until M3/M4) — the tree stays the whole UI there,
 * and the fallback says so instead of rendering nothing.
 */

interface ResourceInspectorProps {
  connection: ResourceConnection | null;
  node: ResourceNode | null;
  onClose: () => void;
  onChanged?: () => void;
}

function InspectorBody({
  connection,
  node,
  onClose,
  onChanged,
}: {
  connection: ResourceConnection;
  node: ResourceNode;
  onClose: () => void;
  onChanged?: () => void;
}) {
  // Resolved, not declared: `Viewer` as a JSX tag would be a component
  // created during render (remounting every pass), so it goes through
  // createElement instead. The lookup cannot miss — getResourceViewer throws
  // on unregistered ids, and the registry test pins every type to a viewer.
  const Viewer = getResourceViewer(connection.type);
  return React.createElement(Viewer, { connection, node, onChanged, onClose });
}

export function ResourceInspector({ connection, node, onClose, onChanged }: ResourceInspectorProps) {
  const isMobile = useIsMobile();
  // Controlled, not owned: the shell mounts per selected node and unmounts on
  // close, so there is no open-state to cover — dismissing hands straight back.
  // (An internal `open` flag here would need a test driving the dialog's
  // dismiss path for one boolean; the shell's conditional mount already is it.)
  const dismiss = () => {
    onClose();
  };

  const body =
    connection && node ? (
      <InspectorBody connection={connection} node={node} onClose={dismiss} onChanged={onChanged} />
    ) : null;

  if (isMobile) {
    return (
      <Drawer
        open
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
      >
        <DrawerContent className="max-h-[95dvh] bg-surface border-hairline text-fg p-4">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Resource</DrawerTitle>
            <DrawerDescription>Inspect a resource object.</DrawerDescription>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open onOpenChange={dismiss}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto bg-surface border-hairline text-fg p-4 md:p-6">
        <DialogTitle className="sr-only">Resource</DialogTitle>
        <DialogDescription className="sr-only">Inspect a resource object.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
