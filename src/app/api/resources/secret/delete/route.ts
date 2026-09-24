import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveVaultOperations, requireSecretPath } from "@/lib/api/resource-vault";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";
import { requireVisibleSecret } from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Delete one secret. Audited as `resource_operation` decision + outcome; the
 * confirm lives client-side (the viewer, twice for Vault's destroy-all form),
 * the trail lives here.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/secret/delete", async (connection, body, { session }) => {
    const path = requireSecretPath(body);
    const user = session.username ?? session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.delete", target);
    try {
      // Admin exclusion rules: an excluded path answers 404 like a missing one.
      await requireVisibleSecret(connection, path);
      const vault = await resolveVaultOperations(connection, "secret.delete");
      await vault.deleteSecret(path);
      endResourceWrite(user, "secret.delete", target, correlationId, null);
      return NextResponse.json({ deleted: true });
    } catch (error) {
      endResourceWrite(user, "secret.delete", target, correlationId, error);
      throw error;
    }
  });
}
