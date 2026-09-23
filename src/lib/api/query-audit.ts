import { emitAuditEvent, type AuditEvent, type AuditReason, type AuditStatementKind } from "@/lib/audit";
import { classifyAuditStatement, maskAuditErrorText, maskAuditStatement } from "@/lib/audit-sql";
import { auditRequestFields } from "@/lib/api/audit-request";
import { QueryCancelledError, TimeoutError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

/**
 * The `query_execution` audit event for the editor query route (StorageBase fork): who ran which
 * statement, where from, against what, and with what outcome - one event per statement the route
 * tried to run, success or failure.
 *
 * `query_execution` was declared in the audit vocabulary long before anything emitted it, so the
 * editor path - the one place a person runs arbitrary SQL - left no trace at all. The route is
 * upstream territory, so it carries only three one-line calls into this module (`attempt`,
 * `succeeded`, `failed`), and every rule about what the event holds lives here:
 *
 * - The statement is MASKED (src/lib/audit-sql.ts) before it becomes a field, and the raw text is
 *   never handed to the emitter, so no sanitizer downstream has to be trusted with it.
 * - Only statements the route tried to run are recorded. A request refused before `attempt` - a
 *   missing body, an unreadable `params` or `explain` field - ran nothing, and neither did an
 *   EXPLAIN the connected engine cannot build; both are answered with a 400 that carries no event.
 * - Recording is isolated: every emit is wrapped, so a broken audit sink can never turn a query
 *   into a 500 or hide its real error (the /api/resources/test precedent). It is the opposite of
 *   the agent path's choice (an agent execution that cannot be audited does not run) on purpose:
 *   the editor's audit is an observation of a user's own action, not an authorisation gate.
 */

const ROUTE = "POST /api/db/query";

/** The kinds whose `rowCount` is a count of rows the statement changed rather than returned. */
const WRITE_KINDS: ReadonlySet<AuditStatementKind> = new Set(["INSERT", "UPDATE", "DELETE"]);

interface QueryAuditSession {
  readonly role: string;
  readonly username?: string;
}

interface QueryAuditOptions {
  /** The client's cancellation id, recorded as a label when it is a string. */
  queryId?: unknown;
  /** Set when the statement ran as an EXPLAIN of the recorded text. */
  explain?: string;
}

export interface QueryAudit {
  /** The statement is about to reach the engine. Nothing is recorded for a request that never gets here. */
  attempt(connection: DatabaseConnection, statement: string, options?: QueryAuditOptions): void;
  /** The engine answered. */
  succeeded(result: Pick<QueryResult, "rows" | "rowCount">): void;
  /** The engine, or the connection to it, failed. A no-op before `attempt`. */
  failed(error: unknown): void;
}

interface Attempt {
  base: Omit<AuditEvent, "id" | "timestamp" | "action" | "result">;
  kind: AuditStatementKind;
  explain: boolean;
  startedAt: number;
}

function failureOf(error: unknown): { action: string; reason: AuditReason } {
  if (error instanceof QueryCancelledError) return { action: "cancelled", reason: "query_cancelled" };
  if (error instanceof TimeoutError) return { action: "timed_out", reason: "query_timeout" };
  return { action: "failed", reason: "query_failed" };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${maskAuditErrorText(error.message)}`;
  return maskAuditErrorText(String(error));
}

function hostOf(connection: DatabaseConnection): string | undefined {
  if (!connection.host) return undefined;
  return connection.port ? `${connection.host}:${connection.port}` : connection.host;
}

export function startQueryAudit(request: { headers: Headers }, session: QueryAuditSession): QueryAudit {
  let attempt: Attempt | null = null;
  let recorded = false;

  function record(build: (current: Attempt) => Omit<AuditEvent, "id" | "timestamp">): void {
    if (attempt === null || recorded) return;
    recorded = true;
    try {
      emitAuditEvent(build(attempt));
    } catch (auditError) {
      logger.error("Failed to record query_execution audit event", auditError, { route: ROUTE });
    }
  }

  return {
    attempt(connection, statement, options = {}) {
      try {
        const masked = maskAuditStatement(statement, connection.type);
        attempt = {
          base: {
            type: "query_execution",
            target: ROUTE,
            user: session.username || session.role,
            role: session.role,
            ...auditRequestFields(request),
            connectionId: connection.id,
            connectionName: connection.name,
            engine: connection.type,
            host: hostOf(connection),
            database: connection.database,
            statement: masked.text,
            ...(masked.truncated ? { statementTruncated: true } : {}),
            ...(typeof options.queryId === "string" ? { queryId: options.queryId } : {}),
          },
          kind: classifyAuditStatement(statement, connection.type),
          explain: options.explain !== undefined,
          startedAt: Date.now(),
        };
      } catch (auditError) {
        logger.error("Failed to prepare query_execution audit event", auditError, { route: ROUTE });
      }
    },

    succeeded(result) {
      record((current) => ({
        ...current.base,
        action: current.explain ? "explained" : "executed",
        result: "success",
        statementKind: current.kind,
        duration: Date.now() - current.startedAt,
        rowsReturned: result.rows.length,
        ...(WRITE_KINDS.has(current.kind) && !current.explain ? { rowsAffected: result.rowCount } : {}),
      }));
    },

    failed(error) {
      record((current) => ({
        ...current.base,
        ...failureOf(error),
        result: "failure",
        statementKind: current.kind,
        duration: Date.now() - current.startedAt,
        error: errorText(error),
      }));
    },
  };
}
