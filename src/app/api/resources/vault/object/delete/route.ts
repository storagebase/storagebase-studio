import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  auditedVaultWrite,
  requireObjectName,
  requireObjectType,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** Delete one object — soft where the vault has a soft delete. Audited decision + outcome. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/object/delete", async (connection, body, context) => {
    const type = requireObjectType(body);
    const name = requireObjectName(body);
    await auditedVaultWrite(context, req, "vault.delete", vaultTarget(connection, type, name), async () =>
      (await resolveVaultWorkbench(connection, type, "vault.delete")).deleteVaultObject(type, name),
    );
    return NextResponse.json({ deleted: true });
  });
}
