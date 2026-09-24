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

/** Recover a soft-deleted object. Audited decision + outcome. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/deleted/recover", async (connection, body, context) => {
    const type = requireObjectType(body);
    const name = requireObjectName(body);
    await auditedVaultWrite(context, req, "vault.recover", vaultTarget(connection, type, name), async () =>
      (await resolveVaultWorkbench(connection, type, "vault.soft-delete")).recoverDeletedVaultObject(type, name),
    );
    return NextResponse.json({ recovered: true });
  });
}
