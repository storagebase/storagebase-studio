import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  auditedVaultWrite,
  requireKeyCreate,
  requireObjectName,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/** Create an RSA or EC key. Audited decision + outcome. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/key/create", async (connection, body, context) => {
    const name = requireObjectName(body);
    const input = requireKeyCreate(body);
    await auditedVaultWrite(context, req, "vault.key.create", vaultTarget(connection, "key", name), async () =>
      (await resolveVaultWorkbench(connection, "key", "vault.key.write")).createKey(name, input),
    );
    return NextResponse.json({ created: true });
  });
}
