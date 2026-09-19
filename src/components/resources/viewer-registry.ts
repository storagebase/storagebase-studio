import type { ComponentType } from "react";
import type { ResourceConnection, ResourceNode, ResourceType } from "@/lib/resources/types";

/**
 * The viewer registry: family milestones register one viewer per type-id, and
 * the shell renders it for the selected tree node. Deliberately a table and
 * NOT a switch (the provider-registry ruling): a family lands as one entry in
 * its own pull request.
 *
 * M2 ships it empty — the viewers arrive with the blob (M2), messaging (M3)
 * and vault (M4) families. Unlike the provider registry, a miss returns
 * `undefined` instead of throwing: a registered provider with no viewer yet
 * degrades to the tree, which must never crash for want of a viewer.
 */

export interface ResourceViewerProps {
  connection: ResourceConnection;
  node: ResourceNode;
}

export type ResourceViewer = ComponentType<ResourceViewerProps>;

const RESOURCE_VIEWERS: Partial<Record<ResourceType, ResourceViewer>> = {};

export function getResourceViewer(type: ResourceType): ResourceViewer | undefined {
  return RESOURCE_VIEWERS[type];
}

export function hasResourceViewer(type: ResourceType): boolean {
  return RESOURCE_VIEWERS[type] !== undefined;
}

/** The one mutation, for family modules and tests. Exported; the fork owns this file outright. */
export function registerResourceViewer(type: ResourceType, viewer: ResourceViewer): void {
  RESOURCE_VIEWERS[type] = viewer;
}
