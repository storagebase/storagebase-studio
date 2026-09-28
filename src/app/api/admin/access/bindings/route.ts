import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, queryId, readJsonBody } from "@/lib/access/admin-api";
import { auditAccessChange } from "@/lib/access/audit";
import { loadSeenRoles } from "@/lib/access/auth-settings";
import { createBinding, deleteBinding, loadAccessState, openAccessStore } from "@/lib/access/store";
import { ACCESS_STORE_UNAVAILABLE_MESSAGE } from "@/lib/access/errors";

export const dynamic = "force-dynamic";

/**
 * Role bindings (StorageBase fork), admin-only: "app role value -> group -> permission". GET lists
 * them with the role values recent sign-ins presented (suggestions — never fetched from the
 * directory); POST creates one, or changes the permission of the binding that already joins that
 * role to that group; DELETE (`?id=`) removes one. Every change is audited.
 */

export async function GET(request: NextRequest) {
  return adminAccessRoute(request, "GET /api/admin/access/bindings", async () => {
    const store = await openAccessStore();
    if (!store) {
      return NextResponse.json({
        bindings: [],
        seenRoles: [],
        storeAvailable: false,
        message: ACCESS_STORE_UNAVAILABLE_MESSAGE,
      });
    }
    const [state, seenRoles] = await Promise.all([loadAccessState(store), loadSeenRoles()]);
    const names = new Map(state.groups.map((group) => [group.id, group.name]));
    const bindings = state.bindings.map((binding) => ({
      ...binding,
      groupName: names.get(binding.groupId) ?? binding.groupId,
    }));
    return NextResponse.json({ bindings, seenRoles, storeAvailable: true });
  });
}

export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/bindings", async (session) => {
    const { binding, replaced } = await createBinding(await readJsonBody(request), session.username);
    auditAccessChange({
      request,
      session,
      type: "access_config",
      action: replaced ? "binding.update" : "binding.create",
      target: `binding:${binding.appRoleValue}->${binding.groupId}`,
      details: { before: replaced, after: binding },
    });
    return NextResponse.json({ binding, replaced: replaced !== null }, { status: replaced ? 200 : 201 });
  });
}

export async function DELETE(request: NextRequest) {
  return adminAccessRoute(request, "DELETE /api/admin/access/bindings", async (session) => {
    const binding = await deleteBinding(queryId(request));
    auditAccessChange({
      request,
      session,
      type: "access_config",
      action: "binding.delete",
      target: `binding:${binding.appRoleValue}->${binding.groupId}`,
      details: { before: binding },
    });
    return NextResponse.json({ binding });
  });
}
