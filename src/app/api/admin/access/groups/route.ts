import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, queryId, readJsonBody } from "@/lib/access/admin-api";
import { auditAccessChange } from "@/lib/access/audit";
import { createGroup, deleteGroup, loadAccessState, openAccessStore, updateGroup } from "@/lib/access/store";
import { ACCESS_STORE_UNAVAILABLE_MESSAGE } from "@/lib/access/errors";

export const dynamic = "force-dynamic";

/**
 * Connection groups (StorageBase fork), admin-only. GET lists them with how many connections and
 * bindings each has; POST creates, PUT renames or re-describes, DELETE (`?id=`) removes a group with
 * its bindings and its membership on every connection. Every change is audited with the record
 * before and after.
 */

export async function GET(request: NextRequest) {
  return adminAccessRoute(request, "GET /api/admin/access/groups", async () => {
    const store = await openAccessStore();
    if (!store)
      return NextResponse.json({ groups: [], storeAvailable: false, message: ACCESS_STORE_UNAVAILABLE_MESSAGE });
    const state = await loadAccessState(store);
    const groups = state.groups.map((group) => ({
      ...group,
      connectionCount: state.connections.filter((connection) => connection.groupIds.includes(group.id)).length,
      bindingCount: state.bindings.filter((binding) => binding.groupId === group.id).length,
    }));
    return NextResponse.json({ groups, storeAvailable: true });
  });
}

export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/groups", async (session) => {
    const group = await createGroup(await readJsonBody(request), session.username);
    auditAccessChange({
      request,
      session,
      type: "access_config",
      action: "group.create",
      target: `group:${group.id}`,
      details: { after: group },
    });
    return NextResponse.json({ group }, { status: 201 });
  });
}

export async function PUT(request: NextRequest) {
  return adminAccessRoute(request, "PUT /api/admin/access/groups", async (session) => {
    const { before, after } = await updateGroup(await readJsonBody(request), session.username);
    auditAccessChange({
      request,
      session,
      type: "access_config",
      action: "group.update",
      target: `group:${after.id}`,
      details: { before, after },
    });
    return NextResponse.json({ group: after });
  });
}

export async function DELETE(request: NextRequest) {
  return adminAccessRoute(request, "DELETE /api/admin/access/groups", async (session) => {
    const result = await deleteGroup(queryId(request), session.username);
    auditAccessChange({
      request,
      session,
      type: "access_config",
      action: "group.delete",
      target: `group:${result.group.id}`,
      details: {
        before: result.group,
        removedBindings: result.removedBindings,
        detachedConnections: result.detachedConnections,
      },
    });
    return NextResponse.json(result);
  });
}
