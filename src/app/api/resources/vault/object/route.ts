import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import {
  requireObjectName,
  requireObjectType,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** One object's metadata and version history — never a value. Audited, counts only. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/object", async (connection, body, context) => {
    const type = requireObjectType(body);
    const name = requireObjectName(body);
    const detail = await auditedResourceRead(
      context,
      req,
      "vault.describe",
      vaultTarget(connection, type, name),
      async () => (await resolveVaultWorkbench(connection, type)).describeVaultObject(type, name),
      (result) => ({ versionsListed: result.versions.length }),
    );
    return NextResponse.json(detail);
  });
}
