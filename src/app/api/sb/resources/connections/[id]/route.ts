import { NextResponse, type NextRequest } from "next/server";
import { adminRequiredResponse, auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import {
  deleteStoredResourceConnection,
  readResourceConnectionInput,
  storedResourceRow,
  updateStoredResourceConnection,
} from "@/storagebase/resources/connections";
import { ResourceRouteError } from "@/storagebase/resources/errors";
import { forkResourceErrorResponse } from "@/storagebase/resources/handle-request";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/sb/resources/connections/[id]";

/**
 * One stored connection, admin-only both actions (the record is shared,
 * deployment-wide — see POST /api/sb/resources/connections for the ruling):
 *
 * - `{ action: "update", connection }` — replaces the non-secret fields and
 *   re-seals the secret ones given; a secret field left blank or absent KEEPS
 *   the stored envelope (the edit form never echoes one back).
 * - `{ action: "delete" }` — removes the record; a missing id is not an error.
 *
 * A `seed:` id is refused with 403 SB_RESOURCE_SEED_READONLY before any store
 * access: preconfigured connections belong to the seed file, and only the file
 * changes them. Every successful write leaves the fork trail's
 * decision+outcome pair; the role denial is upstream's metered line.
 *
 * The route context is OPTIONAL only so a census probe that calls POST with no
 * context destructures nothing before the guard: the guard's 401 is decided
 * before the id, the body or the role is read, exactly as the upstream
 * route-auth census pins for every route under src/app/api.
 */
export async function POST(req: NextRequest, context?: { params: Promise<{ id: string }> }) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request: req });
    return adminRequiredResponse();
  }

  try {
    const { id } = await (context?.params ?? Promise.resolve({ id: "" }));
    const body = (await readBody(req)) as Record<string, unknown>;
    const action = body.action;

    if (action === "update") {
      const read = readResourceConnectionInput(body.connection);
      if (!read.ok) return forkResourceErrorResponse(read.error, { route: "api/sb/resources/connections/[id]" });

      const target = `${read.input.type}:${read.input.name}`;
      const correlationId = beginResourceWrite(guard.session.username, "resource.connection.update", target, req);
      try {
        const record = await updateStoredResourceConnection(id, read.input, guard.session.username);
        endResourceWrite(guard.session.username, "resource.connection.update", target, correlationId, null, req, {
          id: record.id,
          name: record.name,
          type: record.type,
        });
        return NextResponse.json({ connection: storedResourceRow(record) });
      } catch (error) {
        endResourceWrite(guard.session.username, "resource.connection.update", target, correlationId, error, req);
        throw error;
      }
    }

    if (action === "delete") {
      const correlationId = beginResourceWrite(guard.session.username, "resource.connection.delete", id, req);
      try {
        await deleteStoredResourceConnection(id);
        // No connection fields on the outcome: the record is gone, and the id
        // itself is the event's target.
        endResourceWrite(guard.session.username, "resource.connection.delete", id, correlationId, null, req);
        return NextResponse.json({ deleted: true });
      } catch (error) {
        endResourceWrite(guard.session.username, "resource.connection.delete", id, correlationId, error, req);
        throw error;
      }
    }

    return forkResourceErrorResponse(new ResourceRouteError('action must be "update" or "delete"'), {
      route: "api/sb/resources/connections/[id]",
    });
  } catch (error) {
    return forkResourceErrorResponse(error, { route: "api/sb/resources/connections/[id]" });
  }
}

async function readBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
