import type { AccessPermission } from "./types";

/**
 * What each resource route needs of a managed connection's grant (StorageBase fork), keyed by the
 * route name every resource route passes to `handleResourceRequest`.
 *
 * - `read`: list, browse, peek, reveal (still audited), download, inspect.
 * - `write`: create, update, delete an object, publish, produce, upload, soft-delete, recover,
 *   change a topic's configuration or partitions.
 * - `admin`: the irreversible or fleet-wide ones — purge a queue or a soft-deleted vault item,
 *   delete a topic or a consumer group, reset a group's offsets — and the admin preview.
 *
 * A route missing from this table needs `admin`: failing closed means a new route is unusable on a
 * read grant until someone decides what it is, never silently open. tests/unit/lib/access keeps
 * this table and the route tree in step, in both directions.
 */
export const RESOURCE_ROUTE_PERMISSIONS: Readonly<Record<string, AccessPermission>> = {
  "api/resources/tree": "read",
  "api/resources/meta": "read",
  "api/resources/health": "read",
  "api/resources/test": "read",
  "api/resources/blob/meta": "read",
  "api/resources/blob/preview": "read",
  "api/resources/blob/download": "read",
  "api/resources/message/browse": "read",
  "api/resources/secret/read": "read",
  "api/resources/kafka/cluster": "read",
  "api/resources/kafka/topics": "read",
  "api/resources/kafka/topics/counts": "read",
  "api/resources/kafka/topic": "read",
  "api/resources/kafka/messages": "read",
  "api/resources/kafka/groups": "read",
  "api/resources/kafka/groups/lag": "read",
  "api/resources/kafka/group": "read",
  "api/resources/vault/objects": "read",
  "api/resources/vault/object": "read",
  "api/resources/vault/deleted": "read",
  "api/resources/vault/secret/reveal": "read",

  "api/resources/blob/upload": "write",
  "api/resources/blob/delete": "write",
  "api/resources/message/publish": "write",
  "api/resources/secret/write": "write",
  "api/resources/secret/delete": "write",
  "api/resources/kafka/produce": "write",
  "api/resources/kafka/topic/create": "write",
  "api/resources/kafka/topic/config": "write",
  "api/resources/kafka/topic/partitions": "write",
  "api/resources/vault/secret/save": "write",
  "api/resources/vault/key/create": "write",
  "api/resources/vault/certificate/import": "write",
  "api/resources/vault/object/delete": "write",
  "api/resources/vault/deleted/recover": "write",

  "api/resources/message/purge": "admin",
  "api/resources/kafka/topic/delete": "admin",
  "api/resources/kafka/group/delete": "admin",
  "api/resources/kafka/group/reset-offsets": "admin",
  "api/resources/vault/deleted/purge": "admin",
  "api/resources/admin/vault-exclusions/preview": "admin",
  "api/resources/admin/vault-exclusions/applicable": "admin",
};

export function resourceRoutePermission(route: string): AccessPermission {
  return Object.hasOwn(RESOURCE_ROUTE_PERMISSIONS, route) ? RESOURCE_ROUTE_PERMISSIONS[route] : "admin";
}
