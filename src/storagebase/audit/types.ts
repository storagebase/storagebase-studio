import type { AuditEventType } from "@/lib/audit";

/**
 * The fork's audit event schema (StorageBase fork): everything the fork's audit trail records,
 * in one shape that serves all three of its sources — the S2 query-event tap
 * (src/lib/query-events/sink.ts → src/storagebase/core/seams.ts), the S3 upstream-event tap
 * (src/lib/audit.ts → the same seams module) and the fork's own resource routes
 * (src/storagebase/audit/resource.ts, phase 2).
 *
 * P3: the fork never extends an upstream closed union. `type` therefore composes upstream's
 * `AuditEventType` rather than growing it — upstream events keep their own type names, and the
 * fork's one addition (`resource_operation`, which upstream does not declare) is a member of the
 * FORK's union only. The same rule holds for `reason`: upstream's `AuditReason` is a closed union,
 * so the fork's `reason` is a plain string in a fork-owned vocabulary — upstream reason names are
 * a subset of it by construction, and the fork's own emitters write fork codes
 * (`resource_unsupported`, a driver's SQLSTATE) rather than free text.
 *
 * The base fields are upstream's own (id, timestamp, type, action, target, result, user, role,
 * details, duration, reason, correlationId, connectionName, container, engineUser, bucket,
 * passkey, ip), so an upstream event converts to a fork event field-for-field and nothing it
 * recorded is lost on the way to the fork's two destinations. The extended fields are the old
 * fork's (REFORK_ANALYSIS.md §5.2): the statement a query event is about (masked, never raw),
 * the connection and engine it ran on, its outcome counts, the caller's request context, and the
 * identity/grant vocabulary of the access model this phase does not fill
 * (`authProvider`, `subject`, `appRoles`, `permission`, `grantedBy`, `accessGroups`) — they stay
 * in the schema, optional and unfilled, because they are part of the fork vocabulary phase 2
 * emits against.
 *
 * `role` is on the fork event even though upstream's `AuditEvent` carries no role field: every
 * fork source knows the caller's role (the S2 input's principal, the fork routes' sessions), and
 * an operator reading the trail wants it beside `user` without a join.
 */

/** The schema name every fork audit destination stamps: the durable rows and the stdout line. */
export const STORAGEBASE_AUDIT_SCHEMA = "storagebase.audit.v1";

/** The fork's event types: upstream's closed union, plus the one type upstream does not declare. */
export type StoragebaseAuditEventType = AuditEventType | "resource_operation";

/** What kind of statement a `query_execution` event recorded. The query limiter's own vocabulary. */
export type StoragebaseStatementKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "DDL" | "OTHER";

/** Small numeric facts about a resource action: counts only, never a value, body or payload. */
export type StoragebaseAuditCounts = Record<string, number | boolean>;

export interface StoragebaseAuditEvent {
  id: string;
  timestamp: string;
  type: StoragebaseAuditEventType;
  action: string;
  target: string;
  result: "success" | "failure";
  user: string;
  /** The session's role beside `user`; a fork field every fork source knows. */
  role?: string;
  details?: string;
  duration?: number;
  /** A code, never free text: an upstream `AuditReason` name, a fork `resource_*` code, or a driver code. */
  reason?: string;
  /** Joins the decision and outcome events of one resource write (phase 2), or the events of one request. */
  correlationId?: string;
  connectionName?: string;
  /** The CONTAINER the target was addressed in, when the upstream event named one (its meaning). */
  container?: string;
  /** The engine principal an upstream maintenance event acted as (its meaning). */
  engineUser?: string;
  /** Which rate-limit bucket tripped, when an upstream rate_limit_exceeded event named one. */
  bucket?: string;
  /** The internal id of the passkey an upstream account event concerns (its meaning). */
  passkey?: string;
  /**
   * The caller's address. A HINT, never an identity, on the same terms as upstream's `ip`:
   * derived from headers an operator declared trustworthy (TRUST_PROXY_HEADERS), or the address
   * the S2 input's route already resolved.
   */
  ip?: string;

  // ── The fork's extended fields (REFORK_ANALYSIS.md §5.2) ──

  /** Studio's id of the connection the action ran on, as the S2 input's route resolved it. */
  connectionId?: string;
  /** The engine that ran the statement; the S3 source leaves this unset (upstream events carry none). */
  engine?: string;
  /** The connection's configured host field, never parsed out of a connection string. */
  host?: string;
  database?: string;
  statementKind?: StoragebaseStatementKind;
  /**
   * The MASKED statement (src/storagebase/audit/masker.ts), never the raw text: every literal is
   * `?` before the text becomes a field, so no sanitizer downstream has to be trusted with it.
   */
  statement?: string;
  /** Whether `statement` was cut to fit its bound. */
  statementTruncated?: boolean;
  rowsReturned?: number;
  rowsAffected?: number;
  /** The driver's sentence with its quoted values masked (maskAuditErrorText). */
  error?: string;
  /** The client's own cancellation id for the query: client-supplied, so a label, not a key. */
  queryId?: string;
  counts?: StoragebaseAuditCounts;
  /** How the session was established; identifiers and role names, never tokens or raw claims. */
  authProvider?: string;
  subject?: string;
  appRoles?: string;
  /** The grant a managed-connection action ran under: the effective permission and what granted it. */
  permission?: string;
  grantedBy?: string;
  accessGroups?: string;
  /** The raw forwarded chain `ip` was picked from; recorded only while TRUST_PROXY_HEADERS is on. */
  forwardedFor?: string;
  userAgent?: string;
}

/**
 * What a fork emitter hands the sink: the event without the identity the sink owns. `id` and
 * `timestamp` may be carried — the S3 conversion keeps the upstream event's own, so the fork's
 * stdout line and the upstream's share an id an operator can join on — and are minted otherwise.
 */
export type StoragebaseAuditEventInput = Omit<StoragebaseAuditEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};
