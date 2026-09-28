import type { AccessSubject } from "./types";

/**
 * Reading the access-relevant parts of a session (StorageBase fork).
 *
 * The JWT payload is `{ role, username }` upstream; the fork adds `provider`, `appRoles`, `oid` and
 * `tid` (src/lib/auth.ts `UserPayload`). Everything here reads them DEFENSIVELY: a session minted
 * before the fork added them has none, and a payload is only as well-shaped as the code that signed
 * it, so a value that is not what it should be reads as absent rather than being trusted.
 */

/** The bound on captured app roles: a token with more is a misconfiguration, not a user. */
export const MAX_APP_ROLES = 64;
/** The bound on one app-role value, matching Entra's own limit on a role's `value`. */
const MAX_APP_ROLE_LENGTH = 128;

export interface SessionLike {
  readonly role: string;
  readonly username?: string;
  readonly provider?: unknown;
  readonly appRoles?: unknown;
  readonly oid?: unknown;
  readonly tid?: unknown;
}

/**
 * A claim's role values, normalised: strings only, trimmed, non-empty, at most MAX_APP_ROLE_LENGTH
 * each (longer ones are dropped, never truncated into a different value), deduplicated, and at most
 * MAX_APP_ROLES of them.
 */
export function normalizeAppRoles(claim: unknown): string[] {
  const values = Array.isArray(claim) ? claim : typeof claim === "string" ? [claim] : [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_APP_ROLE_LENGTH || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length === MAX_APP_ROLES) break;
  }
  return out;
}

/**
 * The value at a dot-notation claim path (`roles`, `realm_access.roles`), the way `mapOIDCRole`
 * navigates it, or undefined. An empty path names nothing.
 */
export function claimAtPath(claims: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let value: unknown = claims;
  for (const part of path.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The session's app roles, or none. */
function sessionAppRoles(session: SessionLike): string[] {
  return normalizeAppRoles(session.appRoles);
}

/**
 * Every role value the session answers to: the Studio role first, then its app roles. This is what
 * the seed filter (`roles: [...]` in a seed file) and the binding evaluator both match against.
 */
export function sessionRoles(session: SessionLike): string[] {
  return [session.role, ...sessionAppRoles(session).filter((role) => role !== session.role)];
}

export function accessSubject(session: SessionLike): AccessSubject {
  return { role: session.role, appRoles: sessionAppRoles(session) };
}

/** The name an audit event gives the caller. */
export function sessionActor(session: SessionLike): string {
  return session.username || session.role;
}

/** How the session was established; sessions minted before the fork recorded it were local. */
export function sessionProvider(session: SessionLike): "local" | "oidc" | "entra" {
  return session.provider === "entra" || session.provider === "oidc" ? session.provider : "local";
}

/** The identity fields a login or logout audit event carries. */
export function sessionAuditFields(session: SessionLike): {
  authProvider: string;
  subject?: string;
  appRoles?: string;
} {
  const appRoles = sessionAppRoles(session);
  return {
    authProvider: sessionProvider(session),
    ...(typeof session.oid === "string" && session.oid ? { subject: session.oid } : {}),
    ...(appRoles.length > 0 ? { appRoles: appRoles.join(",") } : {}),
  };
}
