import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listManagedResourceRows } from "@/lib/access/resolve";
import { createErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * The admin-managed resource connections the caller's role bindings grant (StorageBase fork), for
 * the browser to list beside its own. Presentation fields and the permission only — never an
 * endpoint, a key id or a credential: the browser uses one by sending `{ connectionId }`, and the
 * server resolves it (src/lib/api/resource-route.ts). An empty list when the deployment has no
 * server storage.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    return NextResponse.json({ connections: await listManagedResourceRows(session) });
  } catch (error) {
    return createErrorResponse(error, { route: "GET /api/resources/managed" });
  }
}
