import type { QueryEventInput } from "@/lib/query-events/types";
import { classifyAuditStatement, maskAuditErrorText, maskAuditStatement } from "./masker";
import type { StoragebaseAuditEventInput, StoragebaseStatementKind } from "./types";

/**
 * The `query_execution` event the S2 tap builds from one `QueryEventInput` (StorageBase fork): who
 * ran which statement, where from, against what, and with what outcome - one event per executed
 * unit the tap hands over, success or failure.
 *
 * The input is upstream's own query-event model (src/lib/query-events/types.ts, verified at the S2
 * ref): a principal (subject, username, role), the connection as its route resolved it (id, name,
 * engine, access level), the statement as the user submitted it, the status, the row count, the
 * error, the client address and the correlation id. What it does NOT carry, the event leaves
 * unset rather than guessing: no host or database (the input's connection names neither), no
 * forwarded chain or user agent (the tap has no request object), and none of the access-model
 * fields (phase 2's vocabulary, unfilled now).
 *
 * - The statement is MASKED (src/storagebase/audit/masker.ts) before it becomes a field, and the
 *   raw text is never copied. `statementTruncated` says the masked text was cut to its bound.
 * - The error text is masked the same way (maskAuditErrorText): drivers echo values back.
 * - `reason` carries the input's `errorCode` - a SQLSTATE, a driver code or a refusal's API code,
 *   never free text - and `action` carries the status.
 * - `rowsAffected` versus `rowsReturned` follows the statement kind: a write's count is what it
 *   changed, and an EXPLAIN never counts as a write however its text reads.
 * - `ip` is filled from the input's `clientIp` when present, otherwise left undefined.
 */

/** The kinds whose `rowCount` is a count of rows the statement changed rather than returned. */
const WRITE_KINDS: ReadonlySet<StoragebaseStatementKind> = new Set(["INSERT", "UPDATE", "DELETE"]);

/** The status of the unit, as the event's action verb. An EXPLAIN that succeeded is "explained". */
function actionOf(input: QueryEventInput): string {
  if (input.status === "refused") return "refused";
  if (input.status === "cancelled") return "cancelled";
  if (input.status === "error") return "failed";
  return input.explain !== undefined ? "explained" : "executed";
}

/** The masked error sentence: the driver's text with its quoted values masked, and the code beside it. */
function errorOf(input: QueryEventInput): Pick<StoragebaseAuditEventInput, "error"> {
  if (input.errorMessage === undefined) return {};
  const masked = maskAuditErrorText(input.errorMessage);
  return masked === "" ? {} : { error: masked };
}

export function storagebaseQueryEvent(input: QueryEventInput): StoragebaseAuditEventInput {
  const engine = input.connection.engine ?? undefined;
  const statement = input.statement;
  const kind =
    input.statementType ??
    (statement !== null && statement !== "" ? classifyAuditStatement(statement, engine) : undefined);
  // A unit with no text (or none to speak of) records no statement at all, not an empty one.
  const masked = statement !== null && statement !== "" ? maskAuditStatement(statement, engine) : null;
  const rowCount = input.rowCount;
  const write = kind !== undefined && WRITE_KINDS.has(kind) && input.explain === undefined;

  return {
    type: "query_execution",
    action: actionOf(input),
    // The surface the unit ran from: the input's own source vocabulary (editor, transaction, ...).
    target: input.source,
    user: input.principal.username || input.principal.role,
    role: input.principal.role,
    subject: input.principal.subject,
    // A refused request is a refusal, not a failure of the unit: the status carries which.
    result: input.status === "success" ? "success" : "failure",
    connectionId: input.connection.id,
    ...(input.connection.name !== null ? { connectionName: input.connection.name } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(kind !== undefined ? { statementKind: kind } : {}),
    ...(masked !== null ? { statement: masked.text } : {}),
    ...(masked !== null && masked.truncated ? { statementTruncated: true } : {}),
    ...(rowCount !== undefined ? (write ? { rowsAffected: rowCount } : { rowsReturned: rowCount }) : {}),
    ...errorOf(input),
    ...(input.errorCode !== undefined ? { reason: input.errorCode } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.clientIp !== undefined ? { ip: input.clientIp } : {}),
    duration: Date.now() - input.started.wallClockMs,
  };
}
