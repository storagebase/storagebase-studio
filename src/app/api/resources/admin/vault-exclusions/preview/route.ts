import { NextResponse, type NextRequest } from "next/server";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { resolveRawVaultWorkbench } from "@/lib/api/resource-vault-workbench";
import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import { VAULT_OBJECT_TYPES } from "@/lib/resources/operations";
import { RESOURCE_CATEGORY_OF } from "@/lib/resources/types";
import { compileVaultExclusions, validateRuleInput } from "@/lib/resources/vault-exclusions";
import { loadVaultExclusions } from "@/lib/resources/vault-exclusions-store";

export const dynamic = "force-dynamic";

const TYPE_FLAG = { secret: "vault.secrets", key: "vault.keys", certificate: "vault.certificates" } as const;

/**
 * Admin-only: "these rules would hide N of M objects of this vault", per
 * object type. The vault is a connection the admin can use — their own inline,
 * or a managed one by `connectionId`, resolved and decrypted on the server —
 * and the rules are the SAVED ones, or `rules` (drafts) when given. Which rules
 * apply is decided exactly as enforcement decides it, on the vault identity the
 * server derives. The listing is read UNFILTERED on the server and only COUNTS
 * leave it — never a name — so previewing cannot reveal what the rules hide.
 */
export async function POST(req: NextRequest) {
  const route = "POST /api/resources/admin/vault-exclusions/preview";
  const guard = await guardAdminRoute(req, route);
  if ("response" in guard) return guard.response;
  return handleResourceRequest(
    req,
    "api/resources/admin/vault-exclusions/preview",
    async (connection, body, context) => {
      if (RESOURCE_CATEGORY_OF[connection.type] !== "vault") {
        throw new ResourceRouteError("Preview needs a vault connection", 400);
      }
      let matcher;
      if (body.rules === undefined) {
        matcher = await loadVaultExclusions(connection);
      } else {
        if (!Array.isArray(body.rules)) throw new ResourceRouteError('"rules" must be an array when present', 400);
        const drafts = body.rules.map((rule, index) => validateRuleInput(rule, `Rule ${index + 1}`));
        matcher = compileVaultExclusions(drafts).forConnection(connection);
      }
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
      return NextResponse.json({ applicableRules: matcher.ruleCount, counts });
    },
  );
}
