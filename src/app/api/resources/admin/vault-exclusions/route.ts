import { NextResponse, type NextRequest } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { guardAdminRoute } from "@/lib/api/resource-admin";
import { emitAuditEvent } from "@/lib/audit";
import { auditRequestFields } from "@/lib/api/audit-request";
import { logger } from "@/lib/logger";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import {
  createVaultExclusionRule,
  deleteVaultExclusionRule,
  loadVaultExclusionRules,
  updateVaultExclusionRule,
  vaultExclusionStoreAvailable,
} from "@/lib/resources/vault-exclusions-store";

export const dynamic = "force-dynamic";

/**
 * Admin-only: the global vault exclusion rules (Admin > Access > Vault
 * exclusions). GET lists them; POST creates one; PUT (`{ id, ...rule }`)
 * replaces one; DELETE (`?id=`) removes one. The rules are enforced
 * server-side on every vault route for everyone, admins included, matched
 * against the vault identity the SERVER derives from the connection it
 * resolved (src/lib/resources/vault-exclusions.ts) — nothing here, or in any
 * other request, tells the server which vault a connection is. Every call is
 * audited; a change records the rule before and after.
 */

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

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ResourceInvalidRequestError("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 200) {
    throw new ResourceInvalidRequestError('"id" must name an exclusion rule');
  }
  return value;
}

export async function GET(request: NextRequest) {
  const route = "GET /api/resources/admin/vault-exclusions";
  const guard = await guardAdminRoute(request, route);
  if ("response" in guard) return guard.response;
  try {
    const rules = await loadVaultExclusionRules();
    const storeAvailable = await vaultExclusionStoreAvailable();
    audit(request, guard.session.username, "vault.exclusions.read", "vault-exclusions");
    return NextResponse.json({
      rules,
      storeAvailable,
      ...(storeAvailable
        ? {}
        : { message: "Vault exclusion rules need server storage: set STORAGE_PROVIDER to sqlite or postgres." }),
    });
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}

/** One mutation: guard, run, audit the outcome (before/after on success), map the error. */
async function mutate(
  request: NextRequest,
  route: string,
  action: string,
  run: (actor: string) => Promise<{ target: string; before: unknown; after: unknown; status?: number }>,
): Promise<NextResponse> {
  const guard = await guardAdminRoute(request, route);
  if ("response" in guard) return guard.response;
  const actor = guard.session.username;
  try {
    const { target, before, after, status } = await run(actor);
    // Patterns are admin configuration, not secret material: the trail keeps
    // the whole before/after so a rule change can be reviewed and undone.
    audit(request, actor, action, target, JSON.stringify({ before, after }));
    return NextResponse.json({ rule: after ?? before }, { status: status ?? 200 });
  } catch (error) {
    audit(request, actor, action, "vault-exclusions", undefined, true);
    return createErrorResponse(error, { route });
  }
}

export async function POST(request: NextRequest) {
  return mutate(request, "POST /api/resources/admin/vault-exclusions", "vault.exclusions.create", async (actor) => {
    const rule = await createVaultExclusionRule(await readBody(request), actor);
    return { target: `vault-exclusion:${rule.id}`, before: null, after: rule, status: 201 };
  });
}

export async function PUT(request: NextRequest) {
  return mutate(request, "PUT /api/resources/admin/vault-exclusions", "vault.exclusions.update", async (actor) => {
    const body = await readBody(request);
    const { before, rule } = await updateVaultExclusionRule(requireId(body.id), body, actor);
    return { target: `vault-exclusion:${rule.id}`, before, after: rule };
  });
}

export async function DELETE(request: NextRequest) {
  return mutate(request, "DELETE /api/resources/admin/vault-exclusions", "vault.exclusions.delete", async (actor) => {
    const before = await deleteVaultExclusionRule(requireId(new URL(request.url).searchParams.get("id")), actor);
    return { target: `vault-exclusion:${before.id}`, before, after: null };
  });
}
