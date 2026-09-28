"use client";

import { Plug } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { ResourceConnectionForm } from "@/components/resources/ResourceConnectionForm";
import { useIsMobile } from "@/hooks/use-mobile";
import { sectionById } from "./sections";
import type { ResourceCategory, ResourceConnection } from "@/lib/resources/types";

interface ResourceConnectionDialogProps {
  /** The page's category: the form offers this family's types and no other, and has no category tabs. */
  category: ResourceCategory;
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: ResourceConnection) => void;
  /** The connection to edit, or a duplicate's prefilled copy; null for a new connection. */
  editConnection: ResourceConnection | null;
}

/**
 * The section page's connection dialog: `ResourceConnectionForm` pinned to one
 * category, in the same shell `ConnectionModal` uses — a dialog, or a drawer
 * below the breakpoint.
 */
export function ResourceConnectionDialog({
  category,
  isOpen,
  onClose,
  onConnect,
  editConnection,
}: ResourceConnectionDialogProps) {
  const isMobile = useIsMobile();
  const title = editConnection ? "Edit Connection" : "New Connection";
  const description = `Configure a ${sectionById(category).connectionNoun} connection.`;

  const body = (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <div className="mb-4 md:mb-6 flex items-center gap-3">
        <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
          <Plug strokeWidth={1.5} className="w-5 h-5 text-brand" />
        </div>
        <div>
          <h2 className="text-xs md:text-[0.8125rem] font-medium">{title}</h2>
          <p className="text-xs text-fg-muted">{description}</p>
        </div>
      </div>
      <ResourceConnectionForm
        category={category}
        isOpen={isOpen}
        onClose={onClose}
        onConnect={onConnect}
        editConnection={editConnection}
      />
    </div>
  );

  if (isMobile) {
    return (
      <Drawer
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DrawerContent className="max-h-[95dvh] bg-surface border-hairline text-fg p-0 flex flex-col">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[500px] lg:max-w-[540px] max-h-[90vh] bg-surface border-hairline text-fg p-0 overflow-hidden shadow-2xl flex flex-col">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
