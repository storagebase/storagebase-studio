import { NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { adminRequiredResponse, auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { logger } from "@/lib/logger";
import {
  AUDIT_EXPORT_MAX_ROWS,
  bufferedAuditEvents,
  readAuditExport,
  readAuditPage,
  readAuditRequest,
} from "@/storagebase/store/admin-query";
import { AuditQueryError } from "@/storagebase/store/types";

/**
 * POST /api/sb/admin/audit (StorageBase fork): the fork admin page's read of the fork audit trail —
 * one page of the filtered events, or the export (up to AUDIT_EXPORT_MAX_ROWS rows, as JSON).
 *
 * The guard is upstream's own (`guardRoute`, the census shape), then the ROLE check this route owns:
 * /sb-admin is JWT-protected by src/proxy.ts but not role-gated the way /admin is, so the role
 * denial is recorded here (auditRoleDenial, upstream's own helper) rather than silently answered.
 *
 * The errors are the fork's own (`SB_AUDIT_*` codes, built directly rather than through upstream's
 * ApiErrorCode table — P3): a body that is not a JSON object, a cursor this route did not mint, and
 * a source that could not answer at all.
 */

const ROUTE = "POST /api/sb/admin/audit";

/** The fork's own error bodies, in upstream's `{ error, code, statusCode }` shape. */
function sbAuditError(message: string, code: string, statusCode: number): NextResponse {
  return NextResponse.json({ error: message, code, statusCode }, { status: statusCode });
}

export async function POST(req: Request) {
  // Moved ahead of req.json(): an unauthenticated caller gets no body parsed on its behalf.
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: ROUTE, user: guard.session.username, request: req });
    return adminRequiredResponse();
  }

  try {
    const body = await readJsonObject(req);
    if (body === null) {
      return sbAuditError(INVALID_REQUEST_BODY, "SB_AUDIT_INVALID_BODY", 400);
    }
    const request = readAuditRequest(body);
    const buffered = bufferedAuditEvents();

    if (request.export) {
      const page = await readAuditExport(request.query, buffered);
      return NextResponse.json({
        events: page.events,
        source: page.source,
        exported: page.events.length,
        maxRows: AUDIT_EXPORT_MAX_ROWS,
      });
    }

    const page = await readAuditPage(request.query, buffered);
    return NextResponse.json({ ...page, total: buffered.length });
  } catch (error) {
    if (error instanceof AuditQueryError) {
      return sbAuditError(error.message, "SB_AUDIT_INVALID_CURSOR", 400);
    }
    logger.error("The fork audit route could not answer", error, { route: ROUTE });
    return sbAuditError("The audit trail could not be read.", "SB_AUDIT_READ_FAILED", 500);
  }
}
