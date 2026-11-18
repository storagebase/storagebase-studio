import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import { requireSecretPath, resolveVaultOperations } from "@/storagebase/resources/providers/vaults/resource-vault";

export const dynamic = "force-dynamic";

/**
 * Read one secret's value (the generic VaultOperations surface, ported from
 * the old fork's /api/resources/secret/read). Audited like a write (decision
 * + outcome) — the deliberate exception to "reads emit nothing": object reads
 * change nothing, but secret material access is exactly what an operator
 * filters the trail for. Tree listings and metadata stay unaudited; only
 * values are recorded.
 *
 * The answer carries the value, so it is `Cache-Control: no-store` — the
 * reveal route's rule, applied to the other value route too.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/secret/read", async (connection, body, context) => {
    const path = requireSecretPath(body);
    const user = context.session.username ?? context.session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.read", target, req, context.connection);
    try {
      const vault = await resolveVaultOperations(connection, "secret.read");
      const read = await vault.readSecret(path);
      endResourceWrite(user, "secret.read", target, correlationId, null, req, context.connection);
      return NextResponse.json(read, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      endResourceWrite(user, "secret.read", target, correlationId, error, req, context.connection);
      throw error;
    }
  });
}
