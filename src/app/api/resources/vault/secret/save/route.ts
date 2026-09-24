import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  auditedVaultWrite,
  requireObjectName,
  requireSecretWrite,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Create a secret, add a version (a value), or update the current version's
 * properties (no value). Audited decision + outcome; the value never enters
 * the event.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/secret/save", async (connection, body, context) => {
    const name = requireObjectName(body);
    const input = requireSecretWrite(body);
    await auditedVaultWrite(context, req, "vault.secret.save", vaultTarget(connection, "secret", name), async () =>
      (await resolveVaultWorkbench(connection, "secret", "vault.secret.write")).saveSecret(name, input),
    );
    return NextResponse.json({ saved: true });
  });
}
