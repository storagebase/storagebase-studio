import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveVaultOperations, requireSecretPath } from "@/lib/api/resource-vault";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Read one secret's value. Audited like a write (decision + outcome) — the
 * deliberate exception to "reads emit nothing": object reads change nothing,
 * but secret material access is exactly what an operator filters the trail
 * for. Tree listings and metadata stay unaudited; only values are recorded.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/secret/read", async (connection, body, { session }) => {
    const path = requireSecretPath(body);
    const user = session.username ?? session.role;
    const target = `${connection.type}:${path}`;
    const correlationId = beginResourceWrite(user, "secret.read", target);
    try {
      const vault = await resolveVaultOperations(connection, "secret.read");
      const read = await vault.readSecret(path);
      endResourceWrite(user, "secret.read", target, correlationId, null);
      return NextResponse.json(read);
    } catch (error) {
      endResourceWrite(user, "secret.read", target, correlationId, error);
      throw error;
    }
  });
}
