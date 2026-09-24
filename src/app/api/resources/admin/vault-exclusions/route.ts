import { NextResponse, type NextRequest } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { emitAuditEvent } from "@/lib/audit";
import { auditRequestFields } from "@/lib/api/audit-request";
import { logger } from "@/lib/logger";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { exclusionKey, validateExclusionRules } from "@/lib/resources/vault-exclusions";
import { loadVaultExclusionRules, saveVaultExclusionRules } from "@/lib/resources/vault-exclusions-store";
import { RESOURCE_CATEGORY_OF, isResourceType } from "@/lib/resources/types";

export const dynamic = "force-dynamic";

/**
 * Admin-only: read and replace one vault's exclusion rules, addressed by
 * `type` + the normalized vault `address` (`normalizedVaultAddress`, which the
 * workbench computes from the connection). Rules are enforced server-side on
 * every vault route for everyone; this API is the only way to change them.
 * Both methods are audited; a PUT records the rule set before and after.
 */

function requireVault(type: unknown, address: unknown): { type: string; address: string } {
  if (!isResourceType(type) || RESOURCE_CATEGORY_OF[type] !== "vault") {
    throw new ResourceInvalidRequestError('"type" must be a vault resource type');
  }
  if (typeof address !== "string" || address.trim() === "" || address.length > 2048) {
    throw new ResourceInvalidRequestError('"address" must be the normalized vault address');
  }
  return { type, address };
}

function audit(request: NextRequest, user: string, action: string, target: string, details?: string, failed = false) {
  try {
    emitAuditEvent({
      type: "resource_operation",
      action,
      target,
      user,
      role: "admin",
      result: failed ? "failure" : "success",
      ...(details === undefined ? {} : { details }),
      ...auditRequestFields(request),
    });
  } catch (auditError) {
    logger.error("Failed to record vault exclusion audit event", auditError, { action });
  }
}

export async function GET(request: NextRequest) {
  const route = "GET /api/resources/admin/vault-exclusions";
  const guard = await guardAdminRoute(request, route);
  if ("response" in guard) return guard.response;
  const params = new URL(request.url).searchParams;
  try {
    const vault = requireVault(params.get("type"), params.get("address"));
    const rules = await loadVaultExclusionRules(exclusionKey(vault.type, vault.address));
    audit(request, guard.session.username, "vault.exclusions.read", `${vault.type}:${vault.address}`);
    return NextResponse.json({ rules });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}

export async function PUT(request: NextRequest) {
  const route = "PUT /api/resources/admin/vault-exclusions";
  const guard = await guardAdminRoute(request, route);
  if ("response" in guard) return guard.response;
  let target = "vault:unknown";
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const vault = requireVault(body.type, body.address);
    target = `${vault.type}:${vault.address}`;
    const rules = validateExclusionRules(body.rules);
    const key = exclusionKey(vault.type, vault.address);
    const before = await loadVaultExclusionRules(key).catch(() => null);
    await saveVaultExclusionRules(key, rules, guard.session.username);
    // Patterns are admin configuration, not secret material: the trail keeps
    // the whole before/after so a rule change can be reviewed and undone.
    audit(request, guard.session.username, "vault.exclusions.update", target, JSON.stringify({ before, after: rules }));
    return NextResponse.json({ rules });
  } catch (error) {
    audit(request, guard.session.username, "vault.exclusions.update", target, undefined, true);
    return createErrorResponse(error, { route });
  }
}
