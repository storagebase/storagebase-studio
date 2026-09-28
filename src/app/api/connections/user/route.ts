import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { forgetUserConnection, isUserConnectionFamily, saveUserConnection } from "@/lib/user-connections/server";

export const dynamic = "force-dynamic";

/**
 * A user's own connection with server-held credentials (StorageBase fork, src/lib/user-connections).
 *
 * POST `{ kind, connection, clear? }` saves it: secrets go into the write-only store (a blank one
 * keeps what is stored, a path in `clear` removes it), the rest into the user's synced collection.
 * The answer is `{ connection }` WITHOUT any secret — only `savedSecrets`, the paths now held.
 *
 * DELETE `{ kind, id }` forgets a connection's stored secrets.
 */

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw new ResourceInvalidRequestError("A JSON body is required");
  if (!isUserConnectionFamily(body.kind)) throw new ResourceInvalidRequestError('kind: "database" or "resource"');
  return body as Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const route = "POST /api/connections/user";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readBody(req);
    const kind = body.kind as "database" | "resource";
    return NextResponse.json({
      connection: await saveUserConnection(guard.session.username, kind, body.connection, body.clear),
    });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}

export async function DELETE(req: NextRequest) {
  const route = "DELETE /api/connections/user";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await readBody(req);
    await forgetUserConnection(guard.session.username, body.kind as "database" | "resource", body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
