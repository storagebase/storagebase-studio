import { NextResponse, type NextRequest } from "next/server";
import { createDatabaseProvider, withOneShotTunnel } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { auditRequestFields } from "@/lib/api/audit-request";
import { guardRoute } from "@/lib/api/require-session";
import { requireManagedPermission } from "@/lib/access/db-guard";
import { accessAuditFields } from "@/lib/access/grant";
import { emitAuditEvent, type AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { RedisKeysRequestError, sessionDatabase, type RedisCommandRunner } from "@/lib/redis-keys/scan";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Shared handling for the Redis key browser's routes (StorageBase fork; docs/providers/redis.md
 * "Key browser").
 *
 * The order is the db routes' own: `guardRoute` (session, `query` rate-limit bucket, denial
 * audit) before the body is read, then `resolveConnection`, so `seed:` and managed references,
 * app-role visibility (an invisible connection answers 404 exactly like a missing one) and inline
 * connections behave as they do on `POST /api/db/query`. A managed grant must cover `read`; every
 * command these routes send (SCAN, TYPE, TTL, MEMORY USAGE) is on the read-only list, so a `read`
 * grant is enough and nothing here can write.
 *
 * Each request opens its OWN short-lived provider for the requested database rather than borrowing
 * the cached one, for the reason redis.md §6 gives for object reads: selecting a database on the
 * shared client would move every concurrent editor query, and a `MULTI` another caller left open
 * there (§5.2a) would queue this walk. SSH tunnels go through the factory's one-shot tunnel.
 *
 * Audited as ONE `query_execution` event per request with counts only: never a key name, a
 * pattern or a value, and never a connection credential.
 */

export interface RedisKeysOperation<P extends { readonly database: number }, T> {
  /**
   * Reads the operation's fields from the body, defaulting the database to the connection's own
   * session database; throws RedisKeysRequestError for anything it cannot accept.
   */
  readonly parse: (body: Record<string, unknown>, sessionDatabase: number) => P;
  readonly run: (runner: RedisCommandRunner, request: P) => Promise<T>;
  readonly counts: (result: T) => Record<string, number | boolean>;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new RedisKeysRequestError("The request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RedisKeysRequestError("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Runs `read` against a provider connected to one numbered database, and closes it. */
async function withDatabase<T>(
  connection: DatabaseConnection,
  database: number,
  read: (runner: RedisCommandRunner) => Promise<T>,
): Promise<T> {
  return withOneShotTunnel({ ...connection, database: String(database) }, async (effective) => {
    const provider = await createDatabaseProvider(effective);
    try {
      await provider.connect();
      return await read(provider);
    } finally {
      await provider.disconnect().catch(() => {});
    }
  });
}

export async function handleRedisKeysRequest<P extends { readonly database: number }, T>(
  req: NextRequest,
  route: string,
  action: string,
  operation: RedisKeysOperation<P, T>,
): Promise<NextResponse> {
  const target = `POST /${route}`;
  const guard = await guardRoute({ route: target, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  const { session } = guard;

  let audit: Omit<AuditEvent, "id" | "timestamp" | "result"> | null = null;
  const startedAt = Date.now();
  const record = (outcome: Pick<AuditEvent, "result" | "reason" | "counts">) => {
    if (audit === null) return;
    try {
      emitAuditEvent({ ...audit, duration: Date.now() - startedAt, ...outcome });
    } catch (auditError) {
      logger.error("Failed to record Redis key browser audit event", auditError, { route });
    }
  };

  try {
    const body = await readBody(req);
    const connection = await resolveConnection(body as Parameters<typeof resolveConnection>[0], session);
    if (connection.type !== "redis") {
      throw new RedisKeysRequestError("The key browser reads Redis connections only");
    }
    requireManagedPermission(req, session, connection, "read", target);

    const request = operation.parse(body, sessionDatabase(connection.database));

    audit = {
      type: "query_execution",
      action,
      target,
      user: session.username || session.role,
      role: session.role,
      ...auditRequestFields(req),
      connectionId: connection.id,
      connectionName: connection.name,
      engine: connection.type,
      ...accessAuditFields(connection),
      database: String(request.database),
    };

    const result = await withDatabase(connection, request.database, (runner) => operation.run(runner, request));
    record({ result: "success", counts: operation.counts(result) });
    return NextResponse.json(result);
  } catch (error) {
    record({ result: "failure", reason: "query_failed" });
    if (error instanceof RedisKeysRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return createErrorResponse(error, { route });
  }
}
