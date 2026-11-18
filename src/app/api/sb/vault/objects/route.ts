import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import {
  requireObjectType,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/storagebase/resources/providers/vaults/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** One tab's listing (secrets, keys or certificates). Audited, counts only. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/objects", async (connection, body, context) => {
    const type = requireObjectType(body);
    const listing = await auditedResourceRead(
      context,
      req,
      "vault.list",
      vaultTarget(connection, type),
      async () => (await resolveVaultWorkbench(connection, type)).listVaultObjects(type),
      (result) => ({ itemsListed: result.objects.length, truncated: result.truncated }),
    );
    return NextResponse.json(listing);
  });
}
