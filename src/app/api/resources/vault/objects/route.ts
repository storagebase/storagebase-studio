import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { requireObjectType, resolveVaultWorkbench, vaultTarget } from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** One tab's listing (secrets, keys or certificates), excluded objects removed. Audited, counts only. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/objects", async (connection, body, context) => {
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
