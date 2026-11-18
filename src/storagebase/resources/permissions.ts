import type { ResourcePermission } from "./types";

/**
 * What each resource route needs of a seeded connection's grant, keyed by the
 * route name every fork resource route passes to `handleResourceRequest`
 * (ported from the legacy access model's resource-permissions.ts — the
 * read/write/admin vocabulary survives D3's config-only decision; the groups
 * and bindings that fed it do not).
 *
 * - `read`: list, browse, peek, reveal (still audited), download, inspect, test.
 * - `write`: create, update, delete an object, publish, produce, upload, soft-delete, recover,
 *   change a topic's configuration or partitions.
 * - `admin`: the irreversible or fleet-wide ones — purge a queue or a soft-deleted vault item,
 *   delete a topic or a consumer group, reset a group's offsets — and the admin preview.
 *
 * A route missing from this table needs `admin`: failing closed means a new route is unusable on a
 * read grant until someone decides what it is, never silently open. tests/storagebase/unit/resources
 * keeps this table and the fork route tree in step, in both directions. The rows below the spine's
 * four are the phase 3 family routes, carried over from the legacy table's classification of the
 * same names; the messaging (kafka) rows land with phase 4.
 */
export const RESOURCE_ROUTE_PERMISSIONS: Readonly<Record<string, ResourcePermission>> = {
  "api/sb/resources/tree": "read",
  "api/sb/resources/meta": "read",
  "api/sb/resources/health": "read",
  "api/sb/resources/test": "read",

  "api/sb/blob/meta": "read",
  "api/sb/blob/preview": "read",
  "api/sb/blob/download": "read",
  "api/sb/vault/objects": "read",
  "api/sb/vault/object": "read",
  "api/sb/vault/deleted": "read",
  "api/sb/vault/secret/reveal": "read",
  "api/sb/vault/secret/read": "read",

  "api/sb/blob/upload": "write",
  "api/sb/blob/delete": "write",
  "api/sb/secret/browse": "read",
  "api/sb/secret/publish": "write",
  "api/sb/secret/purge": "admin",
  "api/sb/vault/secret/save": "write",
  "api/sb/vault/secret/write": "write",
  "api/sb/vault/secret/delete": "write",
  "api/sb/vault/key/create": "write",
  "api/sb/vault/certificate/import": "write",
  "api/sb/vault/object/delete": "write",
  "api/sb/vault/deleted/recover": "write",
  "api/sb/kafka/cluster": "read",
  "api/sb/kafka/topics": "read",
  "api/sb/kafka/topics/counts": "read",
  "api/sb/kafka/topic": "read",
  "api/sb/kafka/messages": "read",
  "api/sb/kafka/groups": "read",
  "api/sb/kafka/groups/lag": "read",
  "api/sb/kafka/group": "read",
  "api/sb/kafka/topic/create": "write",
  "api/sb/kafka/topic/partitions": "write",
  "api/sb/kafka/topic/config": "write",
  "api/sb/kafka/produce": "write",
  "api/sb/kafka/topic/delete": "admin",
  "api/sb/kafka/group/reset-offsets": "admin",
  "api/sb/kafka/group/delete": "admin",

  "api/sb/vault/deleted/purge": "admin",
};

/** The permission levels in rank order; the index is the rank. */
export const RESOURCE_PERMISSIONS: readonly ResourcePermission[] = ["read", "write", "admin"];

export function permissionRank(permission: ResourcePermission): number {
  return RESOURCE_PERMISSIONS.indexOf(permission);
}

/** Whether `granted` covers `required`. */
export function permits(granted: ResourcePermission, required: ResourcePermission): boolean {
  return permissionRank(granted) >= permissionRank(required);
}

export function resourceRoutePermission(route: string): ResourcePermission {
  return Object.hasOwn(RESOURCE_ROUTE_PERMISSIONS, route) ? RESOURCE_ROUTE_PERMISSIONS[route] : "admin";
}
