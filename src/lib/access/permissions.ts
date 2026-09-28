import {
  ACCESS_PERMISSIONS,
  type AccessGrant,
  type AccessPermission,
  type AccessSubject,
  type RoleBinding,
} from "./types";

/**
 * The permission evaluator (StorageBase fork). Pure: no store, no session, no clock — the
 * resolvers load the data and this decides, so every rule below is tested exhaustively on its own.
 *
 * The rules, in full:
 *
 * - A binding MATCHES a connection for a subject when its group is one of the connection's groups
 *   and its app-role value is one of the subject's roles: the session's Studio role (`admin` or
 *   `user`) or any of its app roles. Role values compare trimmed and case-insensitively, the way
 *   `mapOIDCRole` compares admin roles, so an administrator's capitalisation cannot silently lock
 *   a team out. A binding to `user` therefore covers every signed-in user.
 * - The effective permission is the MAXIMUM over matching bindings: bindings only ever add.
 * - No matching binding means NO ACCESS, which the routes answer as "not found" so a non-member
 *   learns nothing about the connection.
 * - Admin bypass (the owner's decision, on in this deployment): a Studio `admin` gets `admin` on
 *   every managed connection, group or no group. Every use of it is audited as `admin-bypass`.
 */

export function permissionRank(permission: AccessPermission): number {
  return ACCESS_PERMISSIONS.indexOf(permission);
}

/** Whether `granted` covers `required`. */
export function permits(granted: AccessPermission, required: AccessPermission): boolean {
  return permissionRank(granted) >= permissionRank(required);
}

/** The comparison form of a role value. */
export function roleKey(value: string): string {
  return value.trim().toLowerCase();
}

export interface EvaluateOptions {
  adminBypass: boolean;
}

export function evaluateAccess(
  subject: AccessSubject,
  connectionGroupIds: readonly string[],
  bindings: readonly RoleBinding[],
  options: EvaluateOptions,
): AccessGrant | null {
  if (options.adminBypass && subject.role === "admin") {
    return { permission: "admin", via: "admin-bypass", roles: [], groupIds: [] };
  }

  const roles = new Set([subject.role, ...subject.appRoles].map(roleKey));
  const groups = new Set(connectionGroupIds);
  const matching = bindings.filter(
    (binding) => groups.has(binding.groupId) && roles.has(roleKey(binding.appRoleValue)),
  );
  if (matching.length === 0) return null;

  const best = Math.max(...matching.map((binding) => permissionRank(binding.permission)));
  const winners = matching.filter((binding) => permissionRank(binding.permission) === best);
  return {
    permission: ACCESS_PERMISSIONS[best],
    via: "binding",
    roles: [...new Set(winners.map((binding) => binding.appRoleValue))],
    groupIds: [...new Set(winners.map((binding) => binding.groupId))],
  };
}

/** The one-line description of a grant the audit trail records in `grantedBy`. */
export function describeGrant(grant: AccessGrant): string {
  return grant.via === "admin-bypass" ? "admin-bypass" : grant.roles.join(",");
}
