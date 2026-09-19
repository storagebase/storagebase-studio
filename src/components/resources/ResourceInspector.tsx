"use client";

import React, { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { getResourceViewer, type ResourceViewerProps } from "@/components/resources/viewer-registry";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

// Family viewer barrels land here, one import per family with a viewer. The
// import is for effect (self-registration); the inspector itself only reads
// the registry, so an unregistered type degrades to the fallback below.
import "@/components/resources/blob";
import "@/components/resources/messaging";

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
  // createElement instead.
  const Viewer = getResourceViewer(connection.type);
  if (!Viewer) {
    return (
      <div data-testid="resource-inspector-fallback" className="space-y-2">
        <h3 className="text-xs font-medium text-fg">{node.name}</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          No viewer is registered for {connection.type} yet — browsing stays in the tree until its family lands.
        </p>
        <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
          Close
        </Button>
      </div>
    );
  }
  return React.createElement(Viewer, { connection, node, onChanged, onClose });
}

export function ResourceInspector({ connection, node, onClose, onChanged }: ResourceInspectorProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose();
  };

  const body =
    connection && node ? (
      <InspectorBody connection={connection} node={node} onClose={close} onChanged={onChanged} />
    ) : null;

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto bg-surface border-hairline text-fg p-4 md:p-6">
        <DialogTitle className="sr-only">Resource</DialogTitle>
        <DialogDescription className="sr-only">Inspect a resource object.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
