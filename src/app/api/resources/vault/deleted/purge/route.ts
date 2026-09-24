import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import {
  auditedVaultWrite,
  requireObjectName,
  requireObjectType,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Permanently purge a soft-deleted object. The body must repeat the name as
 * `confirm` (the typed confirmation, enforced here too). Audited decision +
 * outcome; a purge-protected vault answers with the service's refusal.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/deleted/purge", async (connection, body, context) => {
    const type = requireObjectType(body);
    const name = requireObjectName(body);
    if (body.confirm !== name) throw new ResourceRouteError('"confirm" must repeat the name exactly', 400);
    await auditedVaultWrite(context, req, "vault.purge", vaultTarget(connection, type, name), async () =>
      (await resolveVaultWorkbench(connection, type, "vault.soft-delete")).purgeDeletedVaultObject(type, name),
    );
    return NextResponse.json({ purged: true });
  });
}
