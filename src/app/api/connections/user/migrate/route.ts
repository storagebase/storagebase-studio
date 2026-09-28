import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { migrateUserConnections } from "@/lib/user-connections/server";

export const dynamic = "force-dynamic";

/**
 * The one-time move of a browser's connections into the server's store (StorageBase fork):
 * POST `{ connections?, resourceConnections? }` — the browser's rows that are not yet server-held.
 * Answers both collections as the browser may keep them (no secret, `savedSecrets` set) and how
 * many rows gave up secrets; audited as `connection_secrets_migrated` with the count only.
 * Idempotent: a second call finds nothing left to move.
 */
export async function POST(req: NextRequest) {
  const route = "POST /api/connections/user/migrate";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new ResourceInvalidRequestError("A JSON body is required");
    const username = guard.session.username;
    const database = await migrateUserConnections(username, "database", body.connections ?? []);
    const resource = await migrateUserConnections(username, "resource", body.resourceConnections ?? []);
    return NextResponse.json({
      migrated: database.migrated + resource.migrated,
      connections: database.rows,
      resourceConnections: resource.rows,
    });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
