import { NextRequest } from "next/server";
import { POST as testDatabaseConnection } from "@/app/api/db/test-connection/route";
import { POST as testResourceConnection } from "@/app/api/resources/test/route";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { isUserConnectionFamily, previewUserConnection } from "@/lib/user-connections/server";

export const dynamic = "force-dynamic";

/**
 * "Test connection" while editing a saved connection whose secrets the server holds (StorageBase
 * fork). POST `{ kind, connection, clear? }`: the edited fields, with the stored secrets the save
 * would keep filled in on the server — only while the connection still points where they were
 * saved for — and handed to the ordinary test route of its family, which answers as it always
 * does. Nothing is persisted and no secret is answered.
 *
 * Delegating rather than re-implementing keeps one probe per family (tunnels, single-writer
 * files, the degraded-success story). The delegate runs its own guard, so a test here is metered
 * twice against the query bucket; a test is a click, not a loop.
 */
export async function POST(req: NextRequest) {
  const route = "POST /api/connections/user/test";
  const guard = await guardRoute({ route, bucket: "query", request: req });
  if ("response" in guard) return guard.response;
  try {
    const body = await req.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new ResourceInvalidRequestError("A JSON body is required");
    if (!isUserConnectionFamily(body.kind)) throw new ResourceInvalidRequestError('kind: "database" or "resource"');
    const connection = await previewUserConnection(guard.session.username, body.kind, body.connection, body.clear);
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    const probe = new NextRequest(req.url, { method: "POST", headers, body: JSON.stringify({ connection }) });
    return body.kind === "database" ? await testDatabaseConnection(probe) : await testResourceConnection(probe);
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
