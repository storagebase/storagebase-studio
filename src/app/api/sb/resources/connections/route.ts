import { NextResponse, type NextRequest } from "next/server";
import { adminRequiredResponse, auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import {
  createStoredResourceConnection,
  listStoredResourceConnections,
  readResourceConnectionInput,
  resourceStoreAvailable,
  storedResourceRow,
} from "@/storagebase/resources/connections";
import { ResourceRouteError } from "@/storagebase/resources/errors";
import { forkResourceErrorResponse } from "@/storagebase/resources/handle-request";
import { seededResourceRows } from "@/storagebase/resources/seed";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/sb/resources/connections";

/**
 * The connection catalog: `{ action: "list" }` for every connection this
 * session may use, `{ action: "create", connection }` to add one (admin only).
 *
 * The list is the merge of the two halves the fork serves: the user-created
 * records in the fork store (non-secret fields plus a `hasCredential` marker —
 * a secret value NEVER rides) and the seed file's preconfigured rows, filtered
 * by the session's roles and marked `seeded: true` with their permission, so
 * the UI withholds edit/delete for them and write controls below their grant.
 * `storeAvailable: false` says the deployment has no fork store: the stored
 * half is not "empty", it cannot exist, and the create/update/delete actions
 * answer 503 SB_STORE_UNAVAILABLE.
 *
 * Create is admin-only because a stored record is shared, deployment-wide (the
 * fork store has no per-user scoping): a `user` tests and uses connections —
 * including their own unsaved ones through the inline path — but does not
 * change what everyone else can use. The denial is audited through upstream's
 * metered `auditRoleDenial`, and the successful write leaves the fork trail's
 * decision+outcome pair.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = (await readBody(req)) as Record<string, unknown>;
    const action = body.action;

    if (action === "list") {
      const [stored, seeded, storeAvailable] = await Promise.all([
        listStoredResourceConnections(),
        seededResourceRows(guard.session),
        resourceStoreAvailable(),
      ]);
      const rows = [...stored.map(storedResourceRow), ...seeded].sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ connections: rows, storeAvailable });
    }

    if (action === "create") {
      if (guard.session.role !== "admin") {
        auditRoleDenial({ route: ROUTE, user: guard.session.username, request: req });
        return adminRequiredResponse();
      }
      const read = readResourceConnectionInput(body.connection);
      if (!read.ok) return forkResourceErrorResponse(read.error, { route: "api/sb/resources/connections" });

      const target = `${read.input.type}:${read.input.name}`;
      const correlationId = beginResourceWrite(guard.session.username, "resource.connection.create", target, req);
      try {
        const record = await createStoredResourceConnection(read.input, guard.session.username);
        endResourceWrite(guard.session.username, "resource.connection.create", target, correlationId, null, req, {
          id: record.id,
          name: record.name,
          type: record.type,
        });
        return NextResponse.json({ connection: storedResourceRow(record) });
      } catch (error) {
        endResourceWrite(guard.session.username, "resource.connection.create", target, correlationId, error, req);
        throw error;
      }
    }

    return forkResourceErrorResponse(new ResourceRouteError('action must be "list" or "create"'), {
      route: "api/sb/resources/connections",
    });
  } catch (error) {
    return forkResourceErrorResponse(error, { route: "api/sb/resources/connections" });
  }
}

async function readBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
