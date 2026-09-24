import { NextResponse, type NextRequest } from "next/server";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";

/**
 * The admin gate for fork-owned admin routes under /api/resources/admin:
 * the shared guard (session + rate limit + no-session audit) first, then the
 * role, with the denial recorded by `auditRoleDenial` — the /api/admin/*
 * precedent, reached through `guardRoute` rather than a second session read.
 */
export async function guardAdminRoute(
  request: NextRequest,
  route: string,
): Promise<{ response: NextResponse } | { session: { role: string; username: string } }> {
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard;
  if (guard.session.role !== "admin") {
    auditRoleDenial({ route, user: guard.session.username, request });
    return { response: NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 }) };
  }
  return { session: guard.session };
}
