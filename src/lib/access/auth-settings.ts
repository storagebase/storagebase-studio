import { getForkStore } from "@/lib/fork-store";
import { logger } from "@/lib/logger";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import { entraEnabledByEnv, isEntraConfigured } from "@/lib/entra/config";
import { requireAccessStore } from "./store";
import { isLocalLoginPolicy, type AuthSettings, type LocalLoginPolicy } from "./types";

/**
 * The sign-in switch (StorageBase fork): whether "Sign in with Microsoft" is on, and who may still
 * use email/password. The environment seeds it (`STORAGEBASE_ENTRA_ENABLED`,
 * `STORAGEBASE_LOCAL_LOGIN`); once an administrator saves it, the saved value in the fork store
 * wins, so the switch moves at runtime with no rebuild and no restart.
 *
 * The safety rails, enforced on every read and every save rather than only in the UI:
 * - Entra cannot be on unless it is configured (tenant, client id, secret).
 * - Local sign-in cannot be `disabled` while Entra is off — that would lock everyone out — so that
 *   combination reads, and saves, as `admin-only`.
 * - Turning Entra on from the admin UI needs a successful "test sign-in" in the last day, so an
 *   administrator cannot switch the login page to a flow nobody has seen work.
 */

const SETTINGS_KEY = "access:auth-settings";
const ENTRA_TEST_KEY = "access:entra-test";
const SEEN_ROLES_KEY = "access:seen-roles";

// Single-line, hoisted: bun's line coverage under-counts a wrapped string's continuation lines.
const ENTRA_NOT_CONFIGURED_MESSAGE =
  "Microsoft Entra is not configured: set STORAGEBASE_ENTRA_TENANT_ID, STORAGEBASE_ENTRA_CLIENT_ID and STORAGEBASE_ENTRA_CLIENT_SECRET first";
const ENTRA_TEST_REQUIRED_MESSAGE = "Run a successful test sign-in with Microsoft first (it is valid for 24 hours)";
const LOCAL_LOGIN_POLICY_MESSAGE = 'localLogin: must be "enabled", "admin-only" or "disabled"';

/** How recent a successful test sign-in must be to turn Entra on. */
export const ENTRA_TEST_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** How many distinct role values the suggestion list remembers. */
const MAX_SEEN_ROLES = 200;

interface StoredAuthSettings {
  entraEnabled: boolean;
  localLogin: LocalLoginPolicy;
  updatedAt: string;
  updatedBy: string;
}

/** The rails, applied to any candidate settings. */
function railed(
  entraEnabled: boolean,
  localLogin: LocalLoginPolicy,
): Pick<AuthSettings, "entraEnabled" | "localLogin"> {
  const entra = entraEnabled && isEntraConfigured();
  return { entraEnabled: entra, localLogin: !entra && localLogin === "disabled" ? "admin-only" : localLogin };
}

export function envAuthSettings(): AuthSettings {
  const policy = process.env.STORAGEBASE_LOCAL_LOGIN?.trim().toLowerCase();
  return { ...railed(entraEnabledByEnv(), isLocalLoginPolicy(policy) ? policy : "enabled"), source: "env" };
}

/** The effective settings. Never throws: an unreadable store falls back to the environment. */
export async function loadAuthSettings(): Promise<AuthSettings> {
  try {
    const store = await getForkStore();
    const stored = store ? await store.getSetting<StoredAuthSettings>(SETTINGS_KEY) : null;
    if (stored && typeof stored.entraEnabled === "boolean" && isLocalLoginPolicy(stored.localLogin)) {
      return {
        ...railed(stored.entraEnabled, stored.localLogin),
        source: "store",
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy,
      };
    }
  } catch (error) {
    logger.error("Failed to read the sign-in settings; using the environment's", error, {
      route: "access/auth-settings",
    });
  }
  return envAuthSettings();
}

export interface EntraTestResult {
  ok: boolean;
  at: string;
  by: string;
  /** The claims the test received: the ones access decisions read, never a token. */
  claims?: { roles: string[]; oid?: string; tid?: string; upn?: string; studioRole: "admin" | "user" };
  /** The failure class, from the audit reason vocabulary. */
  error?: string;
}

export async function loadEntraTest(): Promise<EntraTestResult | null> {
  const store = await getForkStore();
  return store ? store.getSetting<EntraTestResult>(ENTRA_TEST_KEY) : null;
}

export async function recordEntraTest(result: EntraTestResult): Promise<void> {
  const store = await requireAccessStore();
  await store.setSetting(ENTRA_TEST_KEY, result, result.by);
}

export async function saveAuthSettings(
  input: unknown,
  actor: string,
  now = Date.now(),
): Promise<{ before: AuthSettings; after: AuthSettings }> {
  const store = await requireAccessStore();
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof body.entraEnabled !== "boolean") {
    throw new ResourceInvalidRequestError("entraEnabled: must be true or false");
  }
  if (!isLocalLoginPolicy(body.localLogin)) {
    throw new ResourceInvalidRequestError(LOCAL_LOGIN_POLICY_MESSAGE);
  }
  if (body.entraEnabled && !isEntraConfigured()) {
    throw new ResourceInvalidRequestError(ENTRA_NOT_CONFIGURED_MESSAGE);
  }
  const before = await loadAuthSettings();
  if (body.entraEnabled && !before.entraEnabled) {
    const test = await loadEntraTest();
    if (!test?.ok || now - Date.parse(test.at) > ENTRA_TEST_VALIDITY_MS) {
      throw new ResourceInvalidRequestError(ENTRA_TEST_REQUIRED_MESSAGE);
    }
  }
  const settings = railed(body.entraEnabled, body.localLogin);
  const stored: StoredAuthSettings = { ...settings, updatedAt: new Date(now).toISOString(), updatedBy: actor };
  await store.setSetting(SETTINGS_KEY, stored, actor);
  return { before, after: { ...settings, source: "store", updatedAt: stored.updatedAt, updatedBy: actor } };
}

export interface SeenRole {
  value: string;
  lastSeenAt: string;
}

/** Remembers the role values a sign-in presented, for the binding form's suggestions. Best effort. */
export async function recordSeenRoles(roles: readonly string[], now = Date.now()): Promise<void> {
  if (roles.length === 0) return;
  try {
    const store = await getForkStore();
    if (!store) return;
    const seen = (await store.getSetting<SeenRole[]>(SEEN_ROLES_KEY)) ?? [];
    const at = new Date(now).toISOString();
    const merged = new Map(seen.map((entry) => [entry.value, entry.lastSeenAt]));
    for (const role of roles) merged.set(role, at);
    const kept = [...merged.entries()]
      .map(([value, lastSeenAt]) => ({ value, lastSeenAt }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.value.localeCompare(b.value))
      .slice(0, MAX_SEEN_ROLES);
    await store.setSetting(SEEN_ROLES_KEY, kept, "sign-in");
  } catch (error) {
    logger.warn("Failed to remember sign-in roles", {
      route: "access/auth-settings",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadSeenRoles(): Promise<SeenRole[]> {
  const store = await getForkStore();
  return (store ? await store.getSetting<SeenRole[]>(SEEN_ROLES_KEY) : null) ?? [];
}

/** What the login page offers, decided on the server at request time. */
export interface LoginProviders {
  entra: boolean;
  /** Email/password is offered. */
  local: boolean;
  /** Email/password is offered to administrators only (break-glass). */
  localAdminOnly: boolean;
  /** The generic OIDC mode (`NEXT_PUBLIC_AUTH_PROVIDER=oidc`) is on. */
  oidc: boolean;
}

export async function loginProviders(): Promise<LoginProviders> {
  const settings = await loadAuthSettings();
  const oidc = (process.env.NEXT_PUBLIC_AUTH_PROVIDER || "local") === "oidc";
  return {
    entra: settings.entraEnabled,
    local: !oidc && settings.localLogin !== "disabled",
    localAdminOnly: settings.localLogin === "admin-only",
    oidc,
  };
}
