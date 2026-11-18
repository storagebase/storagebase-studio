import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import { requireSecretPath, resolveVaultOperations } from "@/storagebase/resources/providers/vaults/resource-vault";

export const dynamic = "force-dynamic";

/**
 * Delete one secret (the generic VaultOperations surface, ported from the old
 * fork's /api/resources/secret/delete). Soft where the vault soft-deletes.
 * Audited as `resource_operation` decision + outcome.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/secret/delete", async (connection, body, context) => {
    const path = requireSecretPath(body);
    const user = context.session.username ?? context.session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.delete", target, req, context.connection);
    try {
      const vault = await resolveVaultOperations(connection, "secret.delete");
      await vault.deleteSecret(path);
      endResourceWrite(user, "secret.delete", target, correlationId, null, req, context.connection);
      return NextResponse.json({ deleted: true });
    } catch (error) {
      endResourceWrite(user, "secret.delete", target, correlationId, error, req, context.connection);
      throw error;
    }
  });
}
