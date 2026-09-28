import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, readJsonBody } from "@/lib/access/admin-api";
import { visibleConnections } from "@/lib/access/resolve";
import { normalizeAppRoles } from "@/lib/access/session";
import { EMPTY_ACCESS_STATE, loadAccessState, openAccessStore } from "@/lib/access/store";

export const dynamic = "force-dynamic";

/**
 * Access preview (StorageBase fork), admin-only: "a user holding these app roles would see these
 * managed connections, at these permissions, through these bindings". `{ roles: string[],
 * studioRole?: "user" | "admin" }` — the Studio role defaults to `user`, so the preview shows what a
 * team member sees rather than what the administrator's own bypass sees. Reads only; nothing is
 * resolved or decrypted.
 */
export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/preview", async () => {
    const body = await readJsonBody(request);
    const subject = { role: body.studioRole === "admin" ? "admin" : "user", appRoles: normalizeAppRoles(body.roles) };
    const store = await openAccessStore();
    const state = store ? await loadAccessState(store) : EMPTY_ACCESS_STATE;
    const rows = (kind: "database" | "resource") =>
      visibleConnections(subject, state, kind).map(({ record, grant }) => ({
        id: record.id,
        name: record.name,
        type: record.type,
        permission: grant.permission,
        via: grant.via,
        roles: grant.roles,
        groups: grant.groupNames,
      }));
    return NextResponse.json({ subject, databases: rows("database"), resources: rows("resource") });
  });
}
