import type { ComponentType } from "react";
import type { ResourceConnection, ResourceNode, ResourceType } from "@/storagebase/resources/types";

/**
 * The viewer registry: family milestones register one viewer per type-id, and
 * the shell renders it for the selected tree node. Deliberately a table and
 * NOT a switch (the provider-registry ruling): a family lands as one entry in
 * its own pull request.
 *
 * Phase 2a ships it empty — the viewers arrive with the blob (phase 3) and
 * messaging (phase 4) families. Unlike the provider registry, a miss returns
 * `undefined` from `hasResourceViewer` (the quiet probe the section page uses)
 * while `getResourceViewer` throws: a registered provider with no viewer yet
 * degrades to the tree, which must never crash for want of a viewer, but a
 * family that forgot its registration is a programmer error and fails loudly
 * where a test pins it, not in a dialog.
 */
export interface ResourceViewerProps {
  connection: ResourceConnection;
  node: ResourceNode;
  /**
   * The viewer calls this after a write (upload, delete) so the shell
   * refreshes the tree behind it. Reads never call it: nothing changed.
   */
  onChanged?: () => void;
  /** The viewer calls this after a delete: the node it showed is gone. */
  onClose?: () => void;
  /**
   * The connection is seeded and granted read only: every write control
   * (upload, delete, publish, purge) is withheld, not merely disabled. Reads —
   * browse, preview, download — stay.
   */
  readOnly?: boolean;
}

export type ResourceViewer = ComponentType<ResourceViewerProps>;

const RESOURCE_VIEWERS: Partial<Record<ResourceType, ResourceViewer>> = {};

export function getResourceViewer(type: ResourceType): ResourceViewer {
  const viewer = RESOURCE_VIEWERS[type];
  if (viewer === undefined) {
    throw new Error(`No viewer registered for resource type "${type}"`);
  }
  return viewer;
}

export function hasResourceViewer(type: ResourceType): boolean {
  return RESOURCE_VIEWERS[type] !== undefined;
}

/** The one mutation, for family modules and tests. Exported; the fork owns this file outright. */
export function registerResourceViewer(type: ResourceType, viewer: ResourceViewer): void {
  RESOURCE_VIEWERS[type] = viewer;
}
