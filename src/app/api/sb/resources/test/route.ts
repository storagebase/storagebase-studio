import { NextResponse } from "next/server";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import { testResourceConnection } from "@/storagebase/resources/factory";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";

export const dynamic = "force-dynamic";

/**
 * Connect, read health, disconnect — nothing cached, so a probe costs nothing
 * after it answers. Mirrors /api/db/test-connection's one-shot shape, and its
 * degraded-success story: a service that connected but would not answer health
 * is a SUCCESS with a warning, not a failure, because the user's next action
 * (browse) may still work.
 *
 * The body carries the connection either way the caller holds it: inline for
 * the pre-save candidate the form is still editing (the secret travels once,
 * is used for the probe, and is stored sealed only when the caller saves), or
 * by id for a stored or seeded one the server resolves.
 *
 * Audited as `resource.test` with the test's own verdict — never the request's
 * — and in isolation: the response below is already decided, and a broken fork
 * sink must not turn a probe into a 500.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/resources/test", async (connection, _body, ctx) => {
    const result = await auditedResourceRead(
      ctx,
      req,
      "resource.test",
      `${connection.type}:${connection.name}`,
      async () => testResourceConnection(connection),
      (outcome) => ({ success: outcome.success, degraded: outcome.degraded }),
    );
    return NextResponse.json(result);
  });
}
