/**
 * The access model (StorageBase fork): connection groups, the role bindings that grant them, the
 * managed (preconfigured) connections they contain, and the sign-in settings.
 *
 * Nothing about any tenant lives in code. An app-role VALUE (`Team.Payments.Read`) is data an
 * administrator types into a binding; Studio never stores an Entra group id, a tenant name or a
 * team name, and it never fetches one. See docs/ENTRA.md.
 */

/** What a binding grants on a group's connections, weakest first. */
export type AccessPermission = "read" | "write" | "admin";

/** The permissions in rank order; the index is the rank. */
export const ACCESS_PERMISSIONS: readonly AccessPermission[] = ["read", "write", "admin"];

export function isAccessPermission(value: unknown): value is AccessPermission {
  return typeof value === "string" && (ACCESS_PERMISSIONS as readonly string[]).includes(value);
}

/** A named set of managed connections. Membership lives on the connection (`groupIds`). */
export interface ConnectionGroup {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** "Whoever holds app role `appRoleValue` may use `groupId`'s connections at `permission`." */
export interface RoleBinding {
  id: string;
  appRoleValue: string;
  groupId: string;
  permission: AccessPermission;
  createdAt: string;
  createdBy: string;
}

export type ManagedConnectionKind = "database" | "resource";

/**
 * A preconfigured connection, stored server-side. `config` is the connection record minus its
 * identity (`id`, `name`, `type`, `createdAt`, which live beside it) with every credential field
 * sealed by the storage encryption (src/lib/storage/connection-secrets.ts). It never leaves the
 * server: users get a redacted row, administrators a redacted row plus which secrets are set.
 */
export interface ManagedConnectionRecord {
  id: string;
  kind: ManagedConnectionKind;
  type: string;
  name: string;
  config: Record<string, unknown>;
  groupIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** Who may use email/password sign-in. */
export type LocalLoginPolicy = "enabled" | "admin-only" | "disabled";

export const LOCAL_LOGIN_POLICIES: readonly LocalLoginPolicy[] = ["enabled", "admin-only", "disabled"];

export function isLocalLoginPolicy(value: unknown): value is LocalLoginPolicy {
  return typeof value === "string" && (LOCAL_LOGIN_POLICIES as readonly string[]).includes(value);
}

/** The sign-in switch. `source` says whether an administrator saved it or the environment seeded it. */
export interface AuthSettings {
  entraEnabled: boolean;
  localLogin: LocalLoginPolicy;
  source: "env" | "store";
  updatedAt?: string;
  updatedBy?: string;
}

/** Who is asking, as the evaluator reads it: the Studio role and the app-role values of the session. */
export interface AccessSubject {
  role: string;
  appRoles: readonly string[];
}

/**
 * The answer to "may this subject use this connection, and how much": the effective permission,
 * how it was reached, and which bindings produced it (for the audit trail and the access preview).
 */
export interface AccessGrant {
  permission: AccessPermission;
  via: "binding" | "admin-bypass";
  /** The app-role values of the bindings that grant `permission` (empty for admin bypass). */
  roles: string[];
  /** The groups through which `permission` was granted (empty for admin bypass). */
  groupIds: string[];
}
