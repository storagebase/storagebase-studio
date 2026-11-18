import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { ResourceRouteError } from "@/storagebase/resources/errors";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import { requireSecretPath, resolveVaultOperations } from "@/storagebase/resources/providers/vaults/resource-vault";

export const dynamic = "force-dynamic";

/**
 * Write one secret (the generic VaultOperations surface, ported from the old
 * fork's /api/resources/secret/write). Audited as `resource_operation`
 * decision + outcome; the value never enters the event.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/secret/write", async (connection, body, context) => {
    const path = requireSecretPath(body);
    if (typeof body.value !== "string") {
      throw new ResourceRouteError('"value" must be a string', 400);
    }
    const user = context.session.username ?? context.session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.write", target, req, context.connection);
    try {
      const vault = await resolveVaultOperations(connection, "secret.write");
      await vault.writeSecret(path, body.value);
      endResourceWrite(user, "secret.write", target, correlationId, null, req, context.connection);
      return NextResponse.json({ written: true });
    } catch (error) {
      endResourceWrite(user, "secret.write", target, correlationId, error, req, context.connection);
      throw error;
    }
  });
}
