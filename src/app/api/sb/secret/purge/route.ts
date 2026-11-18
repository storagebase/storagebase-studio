import { NextResponse } from "next/server";
import { adminRequiredResponse } from "@/lib/api/require-session";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import { requireDestination, resolveSecretOperations } from "@/storagebase/resources/providers/vaults/resource-secret";

export const dynamic = "force-dynamic";

/**
 * Purge a secret by path — the irreversible route of the generic secret
 * surface (ported from the old fork's /api/resources/message/purge). A metadata
 * delete on KV v2 destroys EVERY version, so beyond the seeded connection's
 * `admin` grant (permissions.ts) this route also refuses a non-admin session
 * with the upstream admin-required response; the confirmation lives client-side.
 * Decision and outcome are joined by one correlation id in the fork audit trail.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/secret/purge", async (connection, body, context) => {
    if (context.session.role !== "admin") return adminRequiredResponse();
    const destination = requireDestination(body);
    const user = context.session.username ?? context.session.role;
    const target = `${connection.type}:${destination}`;
    const correlationId = beginResourceWrite(user, "message.purge", target, req, context.connection);
    try {
      const secrets = await resolveSecretOperations(connection, "secret.delete");
      await secrets.deleteSecret(destination);
      endResourceWrite(user, "message.purge", target, correlationId, null, req, context.connection);
      return NextResponse.json({ purged: true });
    } catch (error) {
      endResourceWrite(user, "message.purge", target, correlationId, error, req, context.connection);
      throw error;
    }
  });
}
