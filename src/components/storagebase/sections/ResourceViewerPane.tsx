"use client";

import React from "react";
import { getResourceViewer } from "@/components/storagebase/resources/viewer-registry";
import type { ResourceNode } from "@/storagebase/resources/types";
import type { SectionConnection } from "./connection-body";

// Family viewer barrels land here, one import per family with a viewer. The
// import is for effect (self-registration); the pane reads viewers through the
// registry, and the registry test pins every tree-browsed type to one.
// Vault types have none: every vault opens the vault workbench instead
// (`opensWorkbench`), and so does Kafka.
import "@/components/storagebase/resources/blob";

/**
 * What a tree row opens on a Blob storage page: the family's viewer for the
 * connection's type, full-page in the main area beside the tree — not a dialog
 * over another page.
 */
export function ResourceViewerPane({
  connection,
  node,
  readOnly,
  onChanged,
  onClose,
}: {
  connection: SectionConnection;
  node: ResourceNode;
  readOnly: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Resolved, not declared: `Viewer` as a JSX tag would be a component created
  // during render (remounting every pass), so it goes through createElement.
  const Viewer = getResourceViewer(connection.type);
  return (
    <div data-testid="resource-viewer-pane" className="h-full overflow-auto p-4 md:p-6">
      <div className="max-w-3xl">{React.createElement(Viewer, { connection, node, readOnly, onChanged, onClose })}</div>
    </div>
  );
}
