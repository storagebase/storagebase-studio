"use client";

import React from "react";
import { getResourceViewer } from "@/components/resources/viewer-registry";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

// Family viewer barrels land here, one import per family with a viewer. The
// import is for effect (self-registration); the pane reads viewers through
// the registry, and the registry test pins every tree-browsed type to one.
// Vault types have none: every vault opens the vault workbench instead
// (`opensWorkbench`), and so does Kafka.
import "@/components/resources/blob";
import "@/components/resources/messaging";

/**
 * What a tree row opens on a Blob storage or Messaging page: the family's
 * viewer for the connection's type, full-page in the main area beside the
 * tree — not a dialog over another page.
 */
export function ResourceViewerPane({
  connection,
  node,
  readOnly,
  onChanged,
  onClose,
}: {
  connection: ResourceConnection;
  node: ResourceNode;
  readOnly: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Resolved, not declared: `Viewer` as a JSX tag would be a component created
  // during render (remounting every pass), so it goes through createElement.
  // The lookup cannot miss — getResourceViewer throws on unregistered ids, and
  // the registry test pins every tree-browsed type to a viewer.
  const Viewer = getResourceViewer(connection.type);
  return (
    <div data-testid="resource-viewer-pane" className="h-full overflow-auto p-4 md:p-6">
      <div className="max-w-3xl">{React.createElement(Viewer, { connection, node, readOnly, onChanged, onClose })}</div>
    </div>
  );
}
