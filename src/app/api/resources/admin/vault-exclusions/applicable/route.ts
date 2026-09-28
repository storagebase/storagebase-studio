import { NextResponse, type NextRequest } from "next/server";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { loadVaultExclusions } from "@/lib/resources/vault-exclusions-store";

export const dynamic = "force-dynamic";

/**
 * Admin-only: how many enabled exclusion rules apply to this vault — the
 * workbench's read-only notice. Decided on the server exactly as enforcement
 * decides it (the vault identity of the connection the server resolved), and
 * it answers a count only: no rule, no object, and nothing is listed.
 */
export async function POST(req: NextRequest) {
  const route = "POST /api/resources/admin/vault-exclusions/applicable";
  const guard = await guardAdminRoute(req, route);
  if ("response" in guard) return guard.response;
  return handleResourceRequest(req, "api/resources/admin/vault-exclusions/applicable", async (connection) =>
    NextResponse.json({ applicableRules: (await loadVaultExclusions(connection)).ruleCount }),
  );
}
