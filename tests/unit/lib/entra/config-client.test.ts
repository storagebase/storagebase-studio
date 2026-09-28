import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

/**
 * Entra configuration, the flow-state cookie, and the adapter's own discovery cache (StorageBase
 * fork). openid-client is doubled so discovery is counted without a network; the state cookie is
 * signed and verified for real.
 */

const discovery = mock(async (issuer: URL, clientId: string) => ({ issuer: issuer.href, clientId }));
mock.module("openid-client", () => ({
  discovery,
  ClientSecretPost: (secret: string) => ({ secret }),
}));

const { getEntraConfig, isEntraConfigured, entraEnabledByEnv, DEFAULT_ENTRA_ADMIN_ROLE } = await import(
  "@/lib/entra/config"
);
const { discoverEntra, resetEntraDiscoveryCache, sealEntraState, openEntraState } = await import("@/lib/entra/client");
const { AuthConfigError } = await import("@/lib/auth-errors");

const TENANT = "0A1B2C3D-0000-4000-8000-000000000000";
const NAMES = [
  "STORAGEBASE_ENTRA_TENANT_ID",
  "STORAGEBASE_ENTRA_CLIENT_ID",
  "STORAGEBASE_ENTRA_CLIENT_SECRET",
  "STORAGEBASE_ENTRA_ADMIN_ROLES",
  "STORAGEBASE_ENTRA_ALLOWED_ROLES",
  "STORAGEBASE_ENTRA_REDIRECT_URI",
  "STORAGEBASE_ENTRA_SESSION_HOURS",
  "STORAGEBASE_ENTRA_ENABLED",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.STORAGEBASE_ENTRA_TENANT_ID = TENANT;
  process.env.STORAGEBASE_ENTRA_CLIENT_ID = " client-id ";
  process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "client-secret";
  discovery.mockClear();
  resetEntraDiscoveryCache();
});
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("getEntraConfig", () => {
  test("derives the tenant's v2 issuer and applies the defaults", () => {
    expect(getEntraConfig()).toEqual({
      tenantId: TENANT.toLowerCase(),
      clientId: "client-id",
      clientSecret: "client-secret",
      issuer: `https://login.microsoftonline.com/${TENANT.toLowerCase()}/v2.0`,
      scope: "openid profile email",
      adminRoles: [DEFAULT_ENTRA_ADMIN_ROLE],
      allowedRoles: [],
      sessionSeconds: 8 * 60 * 60,
    });
  });

  test("reads role lists, the redirect URI and the session length", () => {
    process.env.STORAGEBASE_ENTRA_ADMIN_ROLES = "Ops.Admin, Studio.Admin ,";
    process.env.STORAGEBASE_ENTRA_ALLOWED_ROLES = "Team.A.Read";
    process.env.STORAGEBASE_ENTRA_REDIRECT_URI = "http://127.0.0.1:8080/api/auth/entra/callback";
    process.env.STORAGEBASE_ENTRA_SESSION_HOURS = "12";
    expect(getEntraConfig()).toMatchObject({
      adminRoles: ["Ops.Admin", "Studio.Admin"],
      allowedRoles: ["Team.A.Read"],
      redirectUri: "http://127.0.0.1:8080/api/auth/entra/callback",
      sessionSeconds: 12 * 60 * 60,
    });
  });

  test("an out-of-range or malformed session length falls back to 8 hours", () => {
    for (const value of ["0", "169", "eight", "-1"]) {
      process.env.STORAGEBASE_ENTRA_SESSION_HOURS = value;
      expect(getEntraConfig().sessionSeconds).toBe(8 * 60 * 60);
    }
  });

  test("missing values, a domain instead of a tenant GUID, and a bad redirect URI are configuration errors", () => {
    delete process.env.STORAGEBASE_ENTRA_CLIENT_SECRET;
    expect(isEntraConfigured()).toBe(false);
    expect(() => getEntraConfig()).toThrow(AuthConfigError);
    process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "s";
    expect(isEntraConfigured()).toBe(true);
    process.env.STORAGEBASE_ENTRA_TENANT_ID = "example.onmicrosoft.com";
    expect(() => getEntraConfig()).toThrow("tenant) id GUID");
    process.env.STORAGEBASE_ENTRA_TENANT_ID = TENANT;
    process.env.STORAGEBASE_ENTRA_REDIRECT_URI = "ftp://example.com/cb";
    expect(() => getEntraConfig()).toThrow("STORAGEBASE_ENTRA_REDIRECT_URI");
    process.env.STORAGEBASE_ENTRA_REDIRECT_URI = "not a url";
    expect(() => getEntraConfig()).toThrow("STORAGEBASE_ENTRA_REDIRECT_URI");
  });

  test("the switch's environment spellings", () => {
    for (const value of ["true", "1", "on", "YES", " true "]) {
      process.env.STORAGEBASE_ENTRA_ENABLED = value;
      expect(entraEnabledByEnv()).toBe(true);
    }
    for (const value of ["false", "0", "", "enabled"]) {
      process.env.STORAGEBASE_ENTRA_ENABLED = value;
      expect(entraEnabledByEnv()).toBe(false);
    }
    delete process.env.STORAGEBASE_ENTRA_ENABLED;
    expect(entraEnabledByEnv()).toBe(false);
  });
});

describe("discovery", () => {
  test("cached per issuer and client, re-read for another client", async () => {
    const config = getEntraConfig();
    const first = await discoverEntra(config);
    expect(await discoverEntra(config)).toBe(first);
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(String(discovery.mock.calls[0][0])).toBe(config.issuer);
    await discoverEntra({ ...config, clientId: "other" });
    expect(discovery).toHaveBeenCalledTimes(2);
  });
});

describe("flow state", () => {
  test("round-trips, normalising the mode, and keeps the actor only when there is one", async () => {
    const login = await openEntraState(
      await sealEntraState({ code_verifier: "v", state: "s", nonce: "n", redirectUri: "https://h/cb", mode: "login" }),
    );
    expect(login).toEqual({ code_verifier: "v", state: "s", nonce: "n", redirectUri: "https://h/cb", mode: "login" });
    const test = await openEntraState(
      await sealEntraState({
        code_verifier: "v",
        state: "s",
        nonce: "n",
        redirectUri: "https://h/cb",
        mode: "test",
        actor: "root",
      }),
    );
    expect(test).toMatchObject({ mode: "test", actor: "root" });
  });

  test("a tampered state does not open", async () => {
    const sealed = await sealEntraState({
      code_verifier: "v",
      state: "s",
      nonce: "n",
      redirectUri: "r",
      mode: "login",
    });
    await expect(openEntraState(`${sealed}x`)).rejects.toThrow();
  });
});
