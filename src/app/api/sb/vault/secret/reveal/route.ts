import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { ResourceRouteError } from "@/storagebase/resources/errors";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import {
  requireObjectName,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/storagebase/resources/providers/vaults/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Reveal one secret value — the ONLY workbench route that returns one, called
 * only when the reader clicks Reveal, and answered `Cache-Control: no-store`.
 * Audited like every read; the event names the secret and the version, never
 * the value.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/vault/secret/reveal", async (connection, body, context) => {
    const name = requireObjectName(body);
    if (body.version !== undefined && (typeof body.version !== "string" || body.version === "")) {
      throw new ResourceRouteError('"version" must be a non-empty string when present', 400);
    }
    const version = body.version as string | undefined;
    const revealed = await auditedResourceRead(
      context,
      req,
      "vault.secret.reveal",
      `${vaultTarget(connection, "secret", name)}${version === undefined ? "" : `@${version}`}`,
      async () =>
        (await resolveVaultWorkbench(connection, "secret", "vault.secret.reveal")).revealSecret(name, version),
    );
    return NextResponse.json(revealed, { headers: { "Cache-Control": "no-store" } });
  });
}
