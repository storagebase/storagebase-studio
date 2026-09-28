import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { installAccessStore } from "../../helpers/access-store";
import { installAuthMock } from "../../helpers/auth-mock";

/**
 * Sign in with Microsoft Entra ID (StorageBase fork): GET /api/auth/entra/login and
 * /api/auth/entra/callback, with the identity provider doubled at the OIDC engine seam and the
 * sign-in switch on a real SQLite fork store. Tenant ids and role values are placeholders.
 */

const handle = installAccessStore();

mock.module("openid-client", () => ({
  discovery: async () => ({ discovered: true }),
  ClientSecretPost: () => ({}),
}));

const generateAuthUrl = mock(async (_config: unknown, redirectUri: string) => ({
  url: new URL(
    `https://login.microsoftonline.com/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&prompt=login`,
  ),
  state: { code_verifier: "verifier", state: "state", nonce: "nonce" },
}));
let claims: Record<string, unknown> | null = null;
let exchangeError: Error | null = null;
const exchangeCode = mock(async (..._args: unknown[]) => {
  if (exchangeError) throw exchangeError;
  return claims;
});
mock.module("@/lib/oidc", () => ({
  generateAuthUrl,
  exchangeCode,
  getPublicOrigin: (request: Request) => new URL(request.url).origin,
  getOIDCConfig: mock(() => ({})),
  discoverProvider: mock(async () => ({})),
  encryptState: mock(async () => ""),
  decryptState: mock(async () => ({})),
  mapOIDCRole: mock(() => "user"),
  buildLogoutUrl: mock(async () => null),
  resetDiscoveryCache: mock(() => {}),
}));

let session: { role: string; username: string } | null = null;
const login = mock(async (..._args: unknown[]) => {});
installAuthMock({ getSession: () => session, login });

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { value: jar.get(name) as string } : undefined),
  set: (name: string, value: string) => void jar.set(name, value),
  delete: (cookie: { name: string }) => void jar.delete(cookie.name),
};
mock.module("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => ({ get: () => null }),
}));

const { GET: startLogin } = await import("@/app/api/auth/entra/login/route");
const { GET: callback } = await import("@/app/api/auth/entra/callback/route");
const { GET: providers } = await import("@/app/api/auth/providers/route");
const { loadEntraTest, loadSeenRoles } = await import("@/lib/access/auth-settings");
const { resetEntraDiscoveryCache } = await import("@/lib/entra/client");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const auditModule = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");

const TENANT = "00000000-0000-4000-8000-000000000000";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ENV = [
  "STORAGEBASE_ENTRA_TENANT_ID",
  "STORAGEBASE_ENTRA_CLIENT_ID",
  "STORAGEBASE_ENTRA_CLIENT_SECRET",
  "STORAGEBASE_ENTRA_ENABLED",
  "STORAGEBASE_ENTRA_ALLOWED_ROLES",
  "STORAGEBASE_ENTRA_REDIRECT_URI",
  "STORAGEBASE_ENTRA_ADMIN_ROLES",
];
const saved: Record<string, string | undefined> = {};

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "sub-1",
    oid: "object-1",
    tid: TENANT,
    iss: ISSUER,
    preferred_username: "alice@example.com",
    roles: ["Team.Payments.Read"],
    ...overrides,
  };
}

async function begin(query = ""): Promise<Response> {
  return startLogin(new Request(`http://studio.test/api/auth/entra/login${query}`));
}

async function finish(): Promise<Response> {
  return callback(new Request("http://studio.test/api/auth/entra/callback?code=c&state=state"));
}

beforeEach(async () => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.STORAGEBASE_ENTRA_TENANT_ID = TENANT;
  process.env.STORAGEBASE_ENTRA_CLIENT_ID = "client";
  process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "secret";
  process.env.STORAGEBASE_ENTRA_ENABLED = "true";
  await handle.reset();
  jar.clear();
  session = null;
  claims = goodClaims();
  exchangeError = null;
  login.mockClear();
  generateAuthUrl.mockClear();
  exchangeCode.mockClear();
  resetEntraDiscoveryCache();
  getServerAuditBuffer().clear();
  clearRateLimitState();
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function events(type: string) {
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === type);
}

describe("GET /api/auth/providers", () => {
  test("answers what the login page offers", async () => {
    expect(await (await providers()).json()).toEqual({ entra: true, local: true, localAdminOnly: false, oidc: false });
  });
});

describe("starting the sign-in", () => {
  test("redirects to Microsoft with the derived callback, an account picker, and a sealed state cookie", async () => {
    const res = await begin();
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("redirect_uri")).toBe("http://studio.test/api/auth/entra/callback");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(jar.get("entra-state")).toBeString();
  });

  test("an explicit redirect URI is used as is", async () => {
    process.env.STORAGEBASE_ENTRA_REDIRECT_URI = "http://127.0.0.1:8080/api/auth/entra/callback";
    const res = await begin();
    expect(new URL(res.headers.get("location") as string).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8080/api/auth/entra/callback",
    );
  });

  test("switched off: back to the login page with entra_disabled, audited", async () => {
    process.env.STORAGEBASE_ENTRA_ENABLED = "false";
    const res = await begin();
    expect(res.headers.get("location")).toBe("http://studio.test/login?error=entra_disabled");
    expect(events("login_failure")[0]).toMatchObject({ reason: "entra_disabled", authProvider: "entra" });
  });

  test("misconfigured: oidc_config; discovery down: oidc_discovery; after discovery: oidc_failed", async () => {
    process.env.STORAGEBASE_ENTRA_ENABLED = "true";
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await handle.store.setSetting(
        "access:auth-settings",
        { entraEnabled: true, localLogin: "enabled", updatedAt: "t", updatedBy: "r" },
        "r",
      );
      process.env.STORAGEBASE_ENTRA_TENANT_ID = "not-a-guid";
      expect((await begin()).headers.get("location")).toContain("error=oidc_config");

      process.env.STORAGEBASE_ENTRA_TENANT_ID = TENANT;
      const client = await import("@/lib/entra/client");
      const down = spyOn(client, "discoverEntra").mockImplementation(async () => {
        throw new Error("ENOTFOUND");
      });
      expect((await begin()).headers.get("location")).toContain("error=oidc_discovery");
      down.mockRestore();

      generateAuthUrl.mockImplementationOnce(async () => {
        throw new Error("no authorization endpoint");
      });
      expect((await begin()).headers.get("location")).toContain("error=oidc_failed");
    } finally {
      logged.mockRestore();
    }
  });

  test("a test sign-in is for administrators: anonymous goes to login, a user home", async () => {
    expect((await begin("?test=1")).headers.get("location")).toBe("http://studio.test/login");
    session = { role: "user", username: "bob" };
    expect((await begin("?test=1")).headers.get("location")).toBe("http://studio.test/");
    expect(events("permission_denied").map((event) => event.reason)).toEqual(["no_session", "insufficient_role"]);
  });

  test("an administrator's test sign-in runs even with the switch off, and a failure to start says so", async () => {
    process.env.STORAGEBASE_ENTRA_ENABLED = "false";
    session = { role: "admin", username: "root" };
    expect((await begin("?test=1")).headers.get("location")).toContain("login.microsoftonline.com");
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      generateAuthUrl.mockImplementationOnce(async () => {
        throw new Error("down");
      });
      expect((await begin("?test=1")).headers.get("location")).toBe("http://studio.test/admin/access?entraTest=failed");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("completing the sign-in", () => {
  test("a member of the tenant signs in with their app roles for the Entra session length", async () => {
    await begin();
    const res = await finish();
    expect(res.headers.get("location")).toBe("http://studio.test/");
    expect(login).toHaveBeenCalledWith("user", "alice@example.com", {
      provider: "entra",
      appRoles: ["Team.Payments.Read"],
      oid: "object-1",
      tid: TENANT,
      lifetimeSeconds: 8 * 60 * 60,
    });
    expect(jar.has("entra-state")).toBe(false);
    const [success] = events("login_success");
    expect(success).toMatchObject({
      user: "alice@example.com",
      authProvider: "entra",
      subject: "object-1",
      appRoles: "Team.Payments.Read",
    });
    expect((await loadSeenRoles()).map((role) => role.value)).toEqual(["Team.Payments.Read"]);
    // The token request names the redirect URI the authorization request named.
    expect(String(exchangeCode.mock.calls[0][1])).toBe("http://studio.test/api/auth/entra/callback?code=c&state=state");
  });

  test("an admin role makes a Studio admin, compared case-insensitively", async () => {
    claims = goodClaims({ roles: ["storagebase.admin"], preferred_username: undefined, email: "root@example.com" });
    await begin();
    expect((await finish()).headers.get("location")).toBe("http://studio.test/admin");
    expect(login.mock.calls[0].slice(0, 2)).toEqual(["admin", "root@example.com"]);
  });

  test("the username falls back through upn, oid and sub", async () => {
    claims = goodClaims({ preferred_username: undefined, upn: "u@example.com" });
    await begin();
    await finish();
    claims = goodClaims({ preferred_username: undefined, oid: undefined });
    await begin();
    await finish();
    expect(login.mock.calls.map((call) => call[1])).toEqual(["u@example.com", "sub-1"]);
  });

  test("another tenant is refused, by tid or by issuer", async () => {
    for (const overrides of [
      { tid: "11111111-0000-4000-8000-000000000000" },
      { iss: "https://login.microsoftonline.com/other/v2.0" },
      { tid: undefined },
    ]) {
      claims = goodClaims(overrides);
      await begin();
      expect((await finish()).headers.get("location")).toBe("http://studio.test/login?error=entra_tenant_mismatch");
    }
    expect(login).not.toHaveBeenCalled();
  });

  test("STORAGEBASE_ENTRA_ALLOWED_ROLES refuses a user with none of them, but never an admin", async () => {
    process.env.STORAGEBASE_ENTRA_ALLOWED_ROLES = "Team.Ops.Read";
    await begin();
    expect((await finish()).headers.get("location")).toContain("error=entra_role_not_allowed");
    claims = goodClaims({ roles: ["StorageBase.Admin"] });
    await begin();
    expect((await finish()).headers.get("location")).toBe("http://studio.test/admin");
    claims = goodClaims({ roles: ["team.ops.read"] });
    await begin();
    expect((await finish()).headers.get("location")).toBe("http://studio.test/");
  });

  test("the switch turned off between the redirect and the callback refuses", async () => {
    await begin();
    process.env.STORAGEBASE_ENTRA_ENABLED = "false";
    expect((await finish()).headers.get("location")).toContain("error=entra_disabled");
  });

  test("a missing, a tampered, and an exchanged-for-nothing state", async () => {
    expect((await finish()).headers.get("location")).toContain("error=oidc_state_missing");
    jar.set("entra-state", "tampered");
    expect((await finish()).headers.get("location")).toContain("error=oidc_state_invalid");
    await begin();
    claims = null;
    expect((await finish()).headers.get("location")).toContain("error=oidc_no_claims");
  });

  test("an exchange failure is oidc_failed; a configuration or session failure is oidc_config", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await begin();
      exchangeError = new Error("invalid_grant");
      expect((await finish()).headers.get("location")).toContain("error=oidc_failed");

      exchangeError = null;
      await begin();
      process.env.STORAGEBASE_ENTRA_TENANT_ID = "broken";
      expect((await finish()).headers.get("location")).toContain("error=oidc_config");
      process.env.STORAGEBASE_ENTRA_TENANT_ID = TENANT;

      const { AuthConfigError } = await import("@/lib/auth-errors");
      await begin();
      login.mockImplementationOnce(async () => {
        throw new AuthConfigError("JWT_SECRET is missing");
      });
      expect((await finish()).headers.get("location")).toContain("error=oidc_config");
      await begin();
      login.mockImplementationOnce(async () => {
        throw new Error("cookie store gone");
      });
      expect((await finish()).headers.get("location")).toContain("error=oidc_failed");
    } finally {
      logged.mockRestore();
    }
  });

  test("with an explicit redirect URI the browser returns to that origin", async () => {
    process.env.STORAGEBASE_ENTRA_REDIRECT_URI = "http://127.0.0.1:8080/api/auth/entra/callback";
    await begin();
    expect((await finish()).headers.get("location")).toBe("http://127.0.0.1:8080/");
  });

  test("a broken audit sink never changes the outcome", async () => {
    const emit = spyOn(auditModule, "emitAuditEvent").mockImplementation(() => {
      throw new Error("sink down");
    });
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await begin();
      expect((await finish()).headers.get("location")).toBe("http://studio.test/");
    } finally {
      emit.mockRestore();
      logged.mockRestore();
    }
  });
});

describe("a test sign-in", () => {
  beforeEach(() => {
    session = { role: "admin", username: "root" };
  });

  test("records the claims it received and creates no session", async () => {
    await begin("?test=1");
    const res = await finish();
    expect(res.headers.get("location")).toBe("http://studio.test/admin/access?entraTest=ok");
    expect(login).not.toHaveBeenCalled();
    expect(await loadEntraTest()).toMatchObject({
      ok: true,
      by: "root",
      claims: {
        roles: ["Team.Payments.Read"],
        oid: "object-1",
        tid: TENANT,
        upn: "alice@example.com",
        studioRole: "user",
      },
    });
    expect(events("auth_settings_changed")[0]).toMatchObject({ action: "entra.test", user: "root" });
  });

  test("a failed test is recorded with its reason", async () => {
    claims = goodClaims({ tid: "11111111-0000-4000-8000-000000000000" });
    await begin("?test=1");
    expect((await finish()).headers.get("location")).toBe("http://studio.test/admin/access?entraTest=failed");
    expect(await loadEntraTest()).toMatchObject({ ok: false, error: "entra_tenant_mismatch", by: "root" });
  });

  test("without server storage the outcome still returns, unrecorded", async () => {
    await begin("?test=1");
    handle.mode = "none";
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await finish()).headers.get("location")).toBe("http://studio.test/admin/access?entraTest=ok");
      claims = goodClaims({ iss: "x" });
      handle.mode = "store";
      await begin("?test=1");
      handle.mode = "none";
      expect((await finish()).headers.get("location")).toBe("http://studio.test/admin/access?entraTest=failed");
    } finally {
      logged.mockRestore();
    }
  });
});
