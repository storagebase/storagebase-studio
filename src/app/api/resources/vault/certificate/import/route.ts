import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  auditedVaultWrite,
  requireCertificateImport,
  requireObjectName,
  resolveVaultWorkbench,
  vaultTarget,
} from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * Import a certificate file (PEM or PKCS#12, bounded size, optional
 * password). Audited decision + outcome; neither the file nor the password
 * enters the event.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/vault/certificate/import", async (connection, body, context) => {
    const name = requireObjectName(body);
    const input = requireCertificateImport(body);
    await auditedVaultWrite(
      context,
      req,
      "vault.certificate.import",
      vaultTarget(connection, "certificate", name),
      async () =>
        (await resolveVaultWorkbench(connection, "certificate", "vault.certificate.write")).importCertificate(
          name,
          input,
        ),
    );
    return NextResponse.json({ imported: true });
  });
}
