import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveVaultOperations, requireSecretPath } from "@/lib/api/resource-vault";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Write one secret. Audited as `resource_operation` decision + outcome; the
 * confirm lives client-side (the viewer), the trail lives here.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/secret/write", async (connection, body, { session }) => {
    const path = requireSecretPath(body);
    if (typeof body.value !== "string") {
      throw new ResourceRouteError('"value" must be a string', 400);
    }
    const user = session.username ?? session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.write", target);
    try {
      const vault = await resolveVaultOperations(connection, "secret.write");
      await vault.writeSecret(path, body.value);
      endResourceWrite(user, "secret.write", target, correlationId, null);
      return NextResponse.json({ written: true });
    } catch (error) {
      endResourceWrite(user, "secret.write", target, correlationId, error);
      throw error;
    }
  });
}
