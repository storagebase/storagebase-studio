import { NextResponse, type NextRequest } from "next/server";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { resolveRawVaultWorkbench } from "@/lib/api/resource-vault-workbench";
import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import { VAULT_OBJECT_TYPES } from "@/lib/resources/operations";
import { compileExclusions, validateExclusionRules } from "@/lib/resources/vault-exclusions";

export const dynamic = "force-dynamic";

const TYPE_FLAG = { secret: "vault.secrets", key: "vault.keys", certificate: "vault.certificates" } as const;

/**
 * Admin-only: "these rules would hide N of M objects", per object type. The
 * listing is read UNFILTERED on the server and only COUNTS leave it — never a
 * name — so previewing a rule set cannot reveal what the current one hides.
 */
export async function POST(req: NextRequest) {
  const route = "POST /api/resources/admin/vault-exclusions/preview";
  const guard = await guardAdminRoute(req, route);
  if ("response" in guard) return guard.response;
  return handleResourceRequest(
    req,
    "api/resources/admin/vault-exclusions/preview",
    async (connection, body, context) => {
      const matcher = compileExclusions(validateExclusionRules(body.rules));
      const counts = await auditedResourceRead(
        context,
        req,
        "vault.exclusions.preview",
        `${connection.type}:preview`,
        async () => {
          const declared = (await getOrCreateResourceProvider(connection)).getCapabilities().operations;
          const result: Record<string, { total: number; hidden: number }> = {};
          for (const type of VAULT_OBJECT_TYPES.filter((candidate) => declared.includes(TYPE_FLAG[candidate]))) {
            const { objects } = await (await resolveRawVaultWorkbench(connection, type)).listVaultObjects(type);
            result[type] = {
              total: objects.length,
              hidden: objects.filter((object) => matcher.excludes(type, object.name)).length,
            };
          }
          return result;
        },
      );
      return NextResponse.json({ counts });
    },
  );
}
