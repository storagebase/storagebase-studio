import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { requireObjectType, resolveVaultWorkbench, vaultTarget } from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** Soft-deleted objects of one type, excluded ones removed. Audited, counts only. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/deleted", async (connection, body, context) => {
    const type = requireObjectType(body);
    const deleted = await auditedResourceRead(
      context,
      req,
      "vault.list-deleted",
      vaultTarget(connection, type),
      async () => (await resolveVaultWorkbench(connection, type, "vault.soft-delete")).listDeletedVaultObjects(type),
      (result) => ({ itemsListed: result.length }),
    );
    return NextResponse.json({ deleted });
  });
}
