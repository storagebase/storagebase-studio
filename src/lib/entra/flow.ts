import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getBasePath, withBasePath } from "@/lib/config/base-path";
import { getSession, login, shouldMarkCookieSecure } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { exchangeCode, generateAuthUrl, getPublicOrigin } from "@/lib/oidc";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { loadAuthSettings, recordEntraTest, recordSeenRoles } from "@/lib/access/auth-settings";
import { normalizeAppRoles, sessionAuditFields } from "@/lib/access/session";
import { getEntraConfig, type EntraConfig } from "./config";
import { discoverEntra, ENTRA_STATE_COOKIE, openEntraState, sealEntraState } from "./client";

/**
 * Sign in with Microsoft Entra ID (StorageBase fork): Authorization Code + PKCE through the upstream
 * OIDC engine, with the Entra-specific checks around it.
 *
 * - The id token is validated by the engine (signature, `iss` = the tenant's v2 issuer from
 *   discovery, `aud` = the client id, nonce, expiry); this module then refuses any token whose
 *   `tid` or `iss` names another tenant — even if the app registration is later made
 *   multi-tenant, only the configured tenant signs in.
 * - The `roles` claim (app-role values) becomes the session's `appRoles`; any value in
 *   STORAGEBASE_ENTRA_ADMIN_ROLES makes the user a Studio admin. Group claims are never read.
 * - A "test sign-in" (`?test=1`, administrators only) runs the same flow but records the claims it
 *   received for the Authentication tab instead of creating a session.
 *
 * Every outcome is on the audit trail with the reason codes the login page renders.
 */

const LOGIN_ROUTE = "GET /api/auth/entra/login";
const CALLBACK_ROUTE = "GET /api/auth/entra/callback";
const ADMIN_ACCESS_PATH = "/admin/access";

function audit(event: Parameters<typeof emitAuditEvent>[0], route: string): void {
  try {
    emitAuditEvent(event);
  } catch (auditError) {
    logger.error("Failed to record an Entra sign-in audit event", auditError, { route });
  }
}

function auditFailure(route: string, reason: AuditReason, ip: string, user = "anonymous"): void {
  audit(
    {
      type: "login_failure",
      action: "login",
      target: route,
      user,
      result: "failure",
      reason,
      ip,
      authProvider: "entra",
    },
    route,
  );
}

/** Where the browser is sent back to: the configured redirect URI's origin, or the request's public one. */
function appOrigin(request: Request, config: EntraConfig | null): string {
  return config?.redirectUri ? new URL(config.redirectUri).origin : getPublicOrigin(request);
}

function redirectUriFor(request: Request, config: EntraConfig): string {
  return config.redirectUri ?? `${getPublicOrigin(request)}${withBasePath("/api/auth/entra/callback")}`;
}

function toLogin(origin: string, reason: AuditReason): NextResponse {
  return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=${reason}`);
}

function toTestResult(origin: string, outcome: "ok" | "failed"): NextResponse {
  return NextResponse.redirect(`${origin}${withBasePath(ADMIN_ACCESS_PATH)}?entraTest=${outcome}`);
}

function readConfig(): EntraConfig | null {
  try {
    return getEntraConfig();
  } catch {
    return null;
  }
}

export async function startEntraSignIn(request: Request): Promise<NextResponse> {
  const ip = clientAddress(request);
  const test = new URL(request.url).searchParams.get("test") === "1";
  const known = readConfig();
  const origin = appOrigin(request, known);

  let actor: string | undefined;
  if (test) {
    const session = await getSession();
    if (session?.role !== "admin") {
      audit(
        {
          type: "permission_denied",
          action: "denied",
          target: LOGIN_ROUTE,
          user: session?.username ?? "anonymous",
          result: "failure",
          reason: session ? "insufficient_role" : "no_session",
          ip,
        },
        LOGIN_ROUTE,
      );
      return NextResponse.redirect(`${origin}${withBasePath(session ? "/" : "/login")}`);
    }
    actor = session.username;
  } else if (!(await loadAuthSettings()).entraEnabled) {
    auditFailure(LOGIN_ROUTE, "entra_disabled", ip);
    return toLogin(origin, "entra_disabled");
  }

  let discovered = false;
  try {
    const config = getEntraConfig();
    const configuration = await discoverEntra(config);
    discovered = true;
    const redirectUri = redirectUriFor(request, config);
    const { url, state } = await generateAuthUrl(configuration, redirectUri, config.scope);
    // An account picker rather than a forced password prompt: the user may already be signed in
    // to Microsoft, and a test sign-in is the administrator checking which account's claims arrive.
    url.searchParams.set("prompt", "select_account");
    const sealed = await sealEntraState({
      ...state,
      redirectUri,
      mode: test ? "test" : "login",
      ...(actor ? { actor } : {}),
    });
    const cookieStore = await cookies();
    cookieStore.set(ENTRA_STATE_COOKIE, sealed, {
      httpOnly: true,
      secure: await shouldMarkCookieSecure(),
      sameSite: "lax",
      maxAge: 300,
      path: getBasePath() || "/",
    });
    return NextResponse.redirect(url.toString());
  } catch (error) {
    logger.error("Entra sign-in could not start", error, { route: LOGIN_ROUTE });
    const reason: AuditReason =
      error instanceof AuthConfigError ? "oidc_config" : discovered ? "oidc_failed" : "oidc_discovery";
    auditFailure(LOGIN_ROUTE, reason, ip);
    return test ? toTestResult(origin, "failed") : toLogin(origin, reason);
  }
}

/** A string claim, or undefined. */
function stringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function completeEntraSignIn(request: Request): Promise<NextResponse> {
  const ip = clientAddress(request);
  const known = readConfig();
  const origin = appOrigin(request, known);
  const cookieStore = await cookies();
  const sealed = cookieStore.get(ENTRA_STATE_COOKIE)?.value;
  if (!sealed) {
    auditFailure(CALLBACK_ROUTE, "oidc_state_missing", ip);
    return toLogin(origin, "oidc_state_missing");
  }
  cookieStore.delete({ name: ENTRA_STATE_COOKIE, path: getBasePath() || "/" });

  const flow = await openEntraState(sealed).catch(() => null);
  if (!flow) {
    auditFailure(CALLBACK_ROUTE, "oidc_state_invalid", ip);
    return toLogin(origin, "oidc_state_invalid");
  }

  const fail = async (reason: AuditReason): Promise<NextResponse> => {
    auditFailure(CALLBACK_ROUTE, reason, ip, flow.actor);
    if (flow.mode !== "test") return toLogin(origin, reason);
    await recordEntraTest({ ok: false, at: new Date().toISOString(), by: flow.actor ?? "admin", error: reason }).catch(
      () => undefined,
    );
    return toTestResult(origin, "failed");
  };

  let config: EntraConfig;
  let claims: Record<string, unknown> | null;
  try {
    config = getEntraConfig();
    const configuration = await discoverEntra(config);
    const callbackUrl = new URL(flow.redirectUri);
    callbackUrl.search = new URL(request.url).search;
    claims = await exchangeCode(configuration, callbackUrl, flow.code_verifier, flow.state, flow.nonce);
  } catch (error) {
    logger.error("Entra sign-in could not complete", error, { route: CALLBACK_ROUTE });
    return fail(error instanceof AuthConfigError ? "oidc_config" : "oidc_failed");
  }
  if (!claims) return fail("oidc_no_claims");

  const tid = stringClaim(claims, "tid");
  if (tid?.toLowerCase() !== config.tenantId || stringClaim(claims, "iss") !== config.issuer) {
    return fail("entra_tenant_mismatch");
  }

  const appRoles = normalizeAppRoles(claims.roles);
  const adminKeys = new Set(config.adminRoles.map((role) => role.toLowerCase()));
  const role = appRoles.some((value) => adminKeys.has(value.toLowerCase())) ? "admin" : "user";
  const oid = stringClaim(claims, "oid");
  const username =
    stringClaim(claims, "preferred_username") ??
    stringClaim(claims, "email") ??
    stringClaim(claims, "upn") ??
    oid ??
    String(claims.sub);

  if (flow.mode === "test") {
    await recordEntraTest({
      ok: true,
      at: new Date().toISOString(),
      by: flow.actor ?? "admin",
      claims: { roles: appRoles, oid, tid, upn: username, studioRole: role },
    }).catch((error: unknown) =>
      logger.error("Failed to record the Entra test sign-in", error, { route: CALLBACK_ROUTE }),
    );
    audit(
      {
        type: "auth_settings_changed",
        action: "entra.test",
        target: CALLBACK_ROUTE,
        user: flow.actor ?? "admin",
        result: "success",
        ip,
        ...sessionAuditFields({ role, provider: "entra", appRoles, oid }),
      },
      CALLBACK_ROUTE,
    );
    return toTestResult(origin, "ok");
  }

  if (!(await loadAuthSettings()).entraEnabled) return fail("entra_disabled");
  const allowed = new Set(config.allowedRoles.map((value) => value.toLowerCase()));
  if (role !== "admin" && allowed.size > 0 && !appRoles.some((value) => allowed.has(value.toLowerCase()))) {
    return fail("entra_role_not_allowed");
  }

  try {
    await login(role, username, { provider: "entra", appRoles, oid, tid, lifetimeSeconds: config.sessionSeconds });
  } catch (error) {
    logger.error("Entra sign-in could not create a session", error, { route: CALLBACK_ROUTE });
    return fail(error instanceof AuthConfigError ? "oidc_config" : "oidc_failed");
  }
  await recordSeenRoles(appRoles);
  audit(
    {
      type: "login_success",
      action: "login",
      target: CALLBACK_ROUTE,
      user: username,
      role,
      result: "success",
      ip,
      ...sessionAuditFields({ role, provider: "entra", appRoles, oid }),
    },
    CALLBACK_ROUTE,
  );
  return NextResponse.redirect(`${origin}${withBasePath(role === "admin" ? "/admin" : "/")}`);
}
