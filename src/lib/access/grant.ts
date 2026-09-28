import type { AuditEvent } from "@/lib/audit";
import { describeGrant } from "./permissions";
import type { AccessGrant } from "./types";

/**
 * The grant a resolved managed connection carries (StorageBase fork).
 *
 * The resolvers attach it to the connection object they hand a route, under a symbol key, so
 * every guard and audit helper downstream reads the permission the connection was resolved WITH —
 * no second store read, no second evaluation that could disagree with the first. A symbol key
 * survives the object spreads routes make (`{ ...connection, queryTimeout }`) and never survives
 * serialisation: `JSON.stringify` skips it, so it can never reach a response or a log line.
 *
 * A connection without one is user-owned (sent inline by its owner) or a Helm seed: the access
 * model has nothing to say about it, and every guard lets it through unchanged.
 */

export interface ManagedGrant extends AccessGrant {
  /** The display names of `groupIds`, for the audit trail. */
  groupNames: string[];
}

const ACCESS_GRANT = Symbol.for("storagebase.access.grant");

type Carrier = { [ACCESS_GRANT]?: ManagedGrant };

export function attachGrant<T extends object>(connection: T, grant: ManagedGrant): T {
  (connection as Carrier)[ACCESS_GRANT] = grant;
  return connection;
}

export function grantOf(connection: unknown): ManagedGrant | undefined {
  if (typeof connection !== "object" || connection === null) return undefined;
  return (connection as Carrier)[ACCESS_GRANT];
}

/** The audit fields for an action on `connection`, or none when it is not a managed connection. */
export function accessAuditFields(connection: unknown): Pick<AuditEvent, "permission" | "grantedBy" | "accessGroups"> {
  const grant = grantOf(connection);
  if (!grant) return {};
  return {
    permission: grant.permission,
    grantedBy: describeGrant(grant),
    ...(grant.groupNames.length > 0 ? { accessGroups: grant.groupNames.join(",") } : {}),
  };
}
