import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { ResourceRouteError } from "@/storagebase/resources/errors";
import {
  auditedVaultWrite,
  requireObjectName,
  requireObjectType,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/storagebase/resources/providers/vaults/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Permanently purge a soft-deleted object — the workbench's one irreversible
 * action, on the `admin` permission level. The body must repeat the name as
 * `confirm` (the typed confirmation, enforced here too, before the provider
 * is asked). Audited decision + outcome; a purge-protected vault answers with
 * the service's refusal.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/deleted/purge", async (connection, body, context) => {
    const type = requireObjectType(body);
    const name = requireObjectName(body);
    if (body.confirm !== name) throw new ResourceRouteError('"confirm" must repeat the name exactly', 400);
    await auditedVaultWrite(context, req, "vault.purge", vaultTarget(connection, type, name), async () =>
      (await resolveVaultWorkbench(connection, type, "vault.soft-delete")).purgeDeletedVaultObject(type, name),
    );
    return NextResponse.json({ purged: true });
  });
}
