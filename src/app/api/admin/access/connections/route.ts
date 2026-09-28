import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, adminConnectionView, queryId, readJsonBody } from "@/lib/access/admin-api";
import { auditAccessChange } from "@/lib/access/audit";
import { MANAGED_RESOURCE_PREFIX, MANAGED_SEED_PREFIX } from "@/lib/access/resolve";
import {
  createManagedConnection,
  deleteManagedConnection,
  loadAccessState,
  openAccessStore,
  requireAccessStore,
  updateManagedConnection,
} from "@/lib/access/store";
import { ACCESS_STORE_UNAVAILABLE_MESSAGE } from "@/lib/access/errors";
import type { ManagedConnectionRecord } from "@/lib/access/types";
import { removeProvider } from "@/lib/db/factory";
import { removeResourceProvider } from "@/lib/resources/factory";

export const dynamic = "force-dynamic";

/**
 * Managed (preconfigured) connections (StorageBase fork), admin-only. GET lists them with every
 * credential removed and the list of which credentials are set; POST creates one (`kind`,
 * `type`, `name`, `config`, `groupIds`); PUT changes one — a blank or absent secret keeps the stored
 * value, `null` clears it; DELETE (`?id=`) removes one and closes any client it had open.
 * Credentials are sealed with the storage encryption before they are written, and no response or
 * audit line ever carries one.
 */

/** What the audit trail keeps of a change: identity and membership, never configuration values. */
function summary(record: ManagedConnectionRecord, secretsSet: string[]) {
  return { kind: record.kind, type: record.type, name: record.name, groupIds: record.groupIds, secretsSet };
}

async function closeOpenClients(record: ManagedConnectionRecord): Promise<void> {
  if (record.kind === "database")
    await removeProvider(`seed:${MANAGED_SEED_PREFIX}${record.id}`).catch(() => undefined);
  else await removeResourceProvider(`${MANAGED_RESOURCE_PREFIX}${record.id}`);
}

export async function GET(request: NextRequest) {
  return adminAccessRoute(request, "GET /api/admin/access/connections", async () => {
    const store = await openAccessStore();
    if (!store)
      return NextResponse.json({ connections: [], storeAvailable: false, message: ACCESS_STORE_UNAVAILABLE_MESSAGE });
    const state = await loadAccessState(store);
    return NextResponse.json({
      connections: state.connections.map((record) => adminConnectionView(record, state)),
      storeAvailable: true,
    });
  });
}

export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/connections", async (session) => {
    const record = await createManagedConnection(await readJsonBody(request), session.username);
    const view = adminConnectionView(record, await loadAccessState(await requireAccessStore()));
    auditAccessChange({
      request,
      session,
      type: "managed_connection",
      action: "connection.create",
      target: view.clientId,
      details: { after: summary(record, view.secretsSet) },
    });
    return NextResponse.json({ connection: view }, { status: 201 });
  });
}

export async function PUT(request: NextRequest) {
  return adminAccessRoute(request, "PUT /api/admin/access/connections", async (session) => {
    const { before, after } = await updateManagedConnection(await readJsonBody(request), session.username);
    const state = await loadAccessState(await requireAccessStore());
    const beforeView = adminConnectionView(before, state);
    const view = adminConnectionView(after, state);
    await closeOpenClients(after);
    auditAccessChange({
      request,
      session,
      type: "managed_connection",
      action: "connection.update",
      target: view.clientId,
      details: { before: summary(before, beforeView.secretsSet), after: summary(after, view.secretsSet) },
    });
    return NextResponse.json({ connection: view });
  });
}

export async function DELETE(request: NextRequest) {
  return adminAccessRoute(request, "DELETE /api/admin/access/connections", async (session) => {
    const record = await deleteManagedConnection(queryId(request));
    const view = adminConnectionView(record, { groups: [] });
    await closeOpenClients(record);
    auditAccessChange({
      request,
      session,
      type: "managed_connection",
      action: "connection.delete",
      target: view.clientId,
      details: { before: summary(record, view.secretsSet) },
    });
    return NextResponse.json({ deleted: record.id });
  });
}
