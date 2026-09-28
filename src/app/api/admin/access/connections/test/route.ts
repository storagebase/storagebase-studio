import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, readJsonBody } from "@/lib/access/admin-api";
import { auditAccessChange } from "@/lib/access/audit";
import { testManagedConfig } from "@/lib/access/connection-test";
import { loadAccessState, previewManagedConfig, requireAccessStore } from "@/lib/access/store";
import { ResourceInvalidRequestError, ResourceNotFoundError } from "@/lib/resources/errors";

export const dynamic = "force-dynamic";

/**
 * "Test connection" for a managed connection being created or edited (StorageBase fork),
 * admin-only. The body is the form: `{ id?, kind, type, name, config }`. With an `id`, every secret
 * the form left blank is taken from the stored record, so an administrator can test an edit without
 * retyping a password they cannot see. Audited; the answer carries the outcome and the server's
 * sentence, never the configuration.
 */
export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/connections/test", async (session) => {
    const body = await readJsonBody(request);
    const kind = body.kind;
    if (kind !== "database" && kind !== "resource")
      throw new ResourceInvalidRequestError('kind: must be "database" or "resource"');
    if (typeof body.type !== "string") throw new ResourceInvalidRequestError("type: required");
    const submitted = (typeof body.config === "object" && body.config !== null ? body.config : {}) as Record<
      string,
      unknown
    >;

    let stored: Record<string, unknown> = {};
    if (typeof body.id === "string") {
      const state = await loadAccessState(await requireAccessStore());
      const record = state.connections.find((candidate) => candidate.id === body.id);
      if (!record) throw new ResourceNotFoundError(`Managed connection "${body.id}" not found`);
      stored = record.config;
    }
    const name = typeof body.name === "string" ? body.name : "test";
    const result = await testManagedConfig(kind, body.type, name, previewManagedConfig(kind, stored, submitted));
    auditAccessChange({
      request,
      session,
      type: "managed_connection",
      action: "connection.test",
      target: typeof body.id === "string" ? body.id : `draft:${body.type}`,
      failed: !result.success,
    });
    return NextResponse.json(result);
  });
}
