import { AuthConfigError } from "@/lib/auth-errors";

/**
 * Microsoft Entra ID configuration (StorageBase fork), read at request time from the server's
 * environment — never at build time, so one image serves every deployment and the switch needs no
 * rebuild. Nothing about any tenant is compiled in: the tenant id, client id and every role value
 * come from the operator. See docs/ENTRA.md.
 */

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** `https://login.microsoftonline.com/<tenant>/v2.0`, the only issuer this deployment accepts. */
  issuer: string;
  scope: string;
  /** App-role values that make a user a Studio admin, compared case-insensitively. */
  adminRoles: string[];
  /** When non-empty, a user holding none of these (and no admin role) is refused at sign-in. */
  allowedRoles: string[];
  /** The callback URL registered in the app registration, when the request cannot derive it. */
  redirectUri?: string;
  /** How long an Entra session lasts, in seconds. */
  sessionSeconds: number;
}

const ENTRA_AUTHORITY = "https://login.microsoftonline.com";
export const DEFAULT_ENTRA_ADMIN_ROLE = "StorageBase.Admin";
const DEFAULT_ENTRA_SESSION_HOURS = 8;
const MAX_ENTRA_SESSION_HOURS = 168;

/** A directory (tenant) id is a GUID: the `tid` claim is always one, so a domain name could never match it. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-line, hoisted: bun's line coverage under-counts a wrapped string's continuation lines.
const ENTRA_MISSING_MESSAGE =
  "STORAGEBASE_ENTRA_TENANT_ID, STORAGEBASE_ENTRA_CLIENT_ID and STORAGEBASE_ENTRA_CLIENT_SECRET are required for Microsoft Entra sign-in";
const ENTRA_TENANT_MESSAGE = "STORAGEBASE_ENTRA_TENANT_ID must be the directory (tenant) id GUID, not a domain name";
const ENTRA_REDIRECT_MESSAGE = "STORAGEBASE_ENTRA_REDIRECT_URI must be an absolute http:// or https:// URL";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Whether the three required values are present. Says nothing about whether they are right. */
export function isEntraConfigured(): boolean {
  return Boolean(
    process.env.STORAGEBASE_ENTRA_TENANT_ID &&
      process.env.STORAGEBASE_ENTRA_CLIENT_ID &&
      process.env.STORAGEBASE_ENTRA_CLIENT_SECRET,
  );
}

function sessionHours(value: string | undefined): number {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return DEFAULT_ENTRA_SESSION_HOURS;
  const hours = Number.parseInt(value, 10);
  return hours >= 1 && hours <= MAX_ENTRA_SESSION_HOURS ? hours : DEFAULT_ENTRA_SESSION_HOURS;
}

export function getEntraConfig(): EntraConfig {
  const tenantId = process.env.STORAGEBASE_ENTRA_TENANT_ID?.trim();
  const clientId = process.env.STORAGEBASE_ENTRA_CLIENT_ID?.trim();
  const clientSecret = process.env.STORAGEBASE_ENTRA_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) throw new AuthConfigError(ENTRA_MISSING_MESSAGE);
  if (!TENANT_ID.test(tenantId)) throw new AuthConfigError(ENTRA_TENANT_MESSAGE);

  const redirectUri = process.env.STORAGEBASE_ENTRA_REDIRECT_URI?.trim() || undefined;
  if (redirectUri !== undefined) {
    const protocol = URL.parse(redirectUri)?.protocol;
    if (protocol !== "https:" && protocol !== "http:") throw new AuthConfigError(ENTRA_REDIRECT_MESSAGE);
  }

  const adminRoles = list(process.env.STORAGEBASE_ENTRA_ADMIN_ROLES);
  return {
    tenantId: tenantId.toLowerCase(),
    clientId,
    clientSecret,
    issuer: `${ENTRA_AUTHORITY}/${tenantId.toLowerCase()}/v2.0`,
    scope: "openid profile email",
    adminRoles: adminRoles.length > 0 ? adminRoles : [DEFAULT_ENTRA_ADMIN_ROLE],
    allowedRoles: list(process.env.STORAGEBASE_ENTRA_ALLOWED_ROLES),
    ...(redirectUri ? { redirectUri } : {}),
    sessionSeconds: sessionHours(process.env.STORAGEBASE_ENTRA_SESSION_HOURS) * 60 * 60,
  };
}

/** `STORAGEBASE_ENTRA_ENABLED`: the switch's initial position, when no administrator has saved one. */
export function entraEnabledByEnv(): boolean {
  return /^\s*(true|1|on|yes)\s*$/i.test(process.env.STORAGEBASE_ENTRA_ENABLED ?? "");
}
