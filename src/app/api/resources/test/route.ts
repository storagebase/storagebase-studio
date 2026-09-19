import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { testResourceConnection } from "@/lib/resources/factory";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Connect, read health, disconnect — nothing cached, so a probe costs nothing
 * after it answers. Mirrors /api/db/test-connection's one-shot shape, and its
 * degraded-success story: a service that connected but would not answer health
 * is a SUCCESS with a warning, not a failure, because the user's next action
 * (browse) may still work.
 *
 * Audited as `resource_connection_test` with the test's own verdict — never
 * the request's — and in an isolated try/catch: the response below is already
 * decided, and a broken audit sink must not turn a probe into a 500.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/test", async (connection, _body, { session }) => {
    const result = await testResourceConnection(connection);
    const user = session.username ?? session.role;

    try {
      emitAuditEvent({
        type: "resource_connection_test",
        action: "tested",
        target: `${connection.type}:${connection.name}`,
        user,
        result: result.success ? "success" : "failure",
        ...(result.success ? {} : { reason: "resource_unreachable" as const }),
        ...(result.degraded ? { details: "connected, but the health check failed" } : {}),
        ...(result.latencyMs === undefined ? {} : { duration: result.latencyMs }),
      });
    } catch (auditError) {
      logger.error("Failed to record resource_connection_test audit event", auditError, {
        route: "api/resources/test",
      });
    }

    return NextResponse.json(result);
  });
}
