import { NextResponse, type NextRequest } from "next/server";
import { adminAccessRoute, readJsonBody } from "@/lib/access/admin-api";
import { auditAccessChange } from "@/lib/access/audit";
import { loadAuthSettings, loadEntraTest, saveAuthSettings } from "@/lib/access/auth-settings";
import { openAccessStore } from "@/lib/access/store";
import { getEntraConfig, isEntraConfigured } from "@/lib/entra/config";

export const dynamic = "force-dynamic";

/**
 * The sign-in switch (StorageBase fork), admin-only. GET answers the effective settings, whether
 * Entra is configured (and, when it is, the non-secret half of that configuration so the
 * administrator can check it), the last test sign-in, and whether the settings can be saved at all
 * (they need server storage). POST saves `{ entraEnabled, localLogin }` through the safety rails in
 * src/lib/access/auth-settings.ts; the change is audited with before and after.
 */

function entraSummary() {
  if (!isEntraConfigured()) return null;
  try {
    const config = getEntraConfig();
    return {
      tenantId: config.tenantId,
      clientId: config.clientId,
      redirectUri: config.redirectUri ?? null,
      adminRoles: config.adminRoles,
      allowedRoles: config.allowedRoles,
      sessionHours: config.sessionSeconds / 3600,
      error: null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function GET(request: NextRequest) {
  return adminAccessRoute(request, "GET /api/admin/access/auth-settings", async () => {
    const [settings, store] = await Promise.all([loadAuthSettings(), openAccessStore()]);
    return NextResponse.json({
      settings,
      entra: entraSummary(),
      test: store ? await loadEntraTest() : null,
      storeAvailable: store !== null,
    });
  });
}

export async function POST(request: NextRequest) {
  return adminAccessRoute(request, "POST /api/admin/access/auth-settings", async (session) => {
    const { before, after } = await saveAuthSettings(await readJsonBody(request), session.username);
    auditAccessChange({
      request,
      session,
      type: "auth_settings_changed",
      action: "auth.settings.update",
      target: "auth-settings",
      details: {
        before: { entraEnabled: before.entraEnabled, localLogin: before.localLogin },
        after: { entraEnabled: after.entraEnabled, localLogin: after.localLogin },
      },
    });
    return NextResponse.json({ settings: after });
  });
}
