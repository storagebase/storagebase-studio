import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { installAccessStore } from "../../../helpers/access-store";

/**
 * The sign-in switch (StorageBase fork): the environment seeds it, a saved value wins, and the
 * rails hold on every read and every save — Entra cannot be on unconfigured, local sign-in cannot be
 * disabled while Entra is off, and turning Entra on needs a recent successful test sign-in.
 */

const handle = installAccessStore();
const settings = await import("@/lib/access/auth-settings");
const { localLoginGate, LOCAL_LOGIN_DISABLED_MESSAGE } = await import("@/lib/access/local-login");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");

const ENV = [
  "STORAGEBASE_ENTRA_TENANT_ID",
  "STORAGEBASE_ENTRA_CLIENT_ID",
  "STORAGEBASE_ENTRA_CLIENT_SECRET",
  "STORAGEBASE_ENTRA_ENABLED",
  "STORAGEBASE_LOCAL_LOGIN",
  "NEXT_PUBLIC_AUTH_PROVIDER",
];
const saved: Record<string, string | undefined> = {};

function configureEntra(): void {
  process.env.STORAGEBASE_ENTRA_TENANT_ID = "00000000-0000-0000-0000-000000000000";
  process.env.STORAGEBASE_ENTRA_CLIENT_ID = "client";
  process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "secret";
}

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

beforeEach(async () => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  await handle.reset();
  getServerAuditBuffer().clear();
  clearRateLimitState();
});
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("reading the switch", () => {
  test("defaults: Entra off, local sign-in enabled, from the environment", async () => {
    expect(await settings.loadAuthSettings()).toEqual({ entraEnabled: false, localLogin: "enabled", source: "env" });
  });

  test("the environment seeds it, and the rails apply to the environment too", async () => {
    process.env.STORAGEBASE_ENTRA_ENABLED = "true";
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    // Not configured: Entra reads as off, so "disabled" reads as admin-only.
    expect(settings.envAuthSettings()).toEqual({ entraEnabled: false, localLogin: "admin-only", source: "env" });
    configureEntra();
    expect(settings.envAuthSettings()).toEqual({ entraEnabled: true, localLogin: "disabled", source: "env" });
    process.env.STORAGEBASE_LOCAL_LOGIN = "sometimes";
    expect(settings.envAuthSettings().localLogin).toBe("enabled");
  });

  test("a saved value wins over the environment; a malformed one is ignored", async () => {
    configureEntra();
    await handle.store.setSetting(
      "access:auth-settings",
      { entraEnabled: true, localLogin: "admin-only", updatedAt: "t", updatedBy: "root" },
      "root",
    );
    expect(await settings.loadAuthSettings()).toEqual({
      entraEnabled: true,
      localLogin: "admin-only",
      source: "store",
      updatedAt: "t",
      updatedBy: "root",
    });
    await handle.store.setSetting("access:auth-settings", { entraEnabled: "yes", localLogin: "admin-only" }, "root");
    expect((await settings.loadAuthSettings()).source).toBe("env");
  });

  test("a saved Entra-on reads as off once Entra is no longer configured", async () => {
    await handle.store.setSetting(
      "access:auth-settings",
      { entraEnabled: true, localLogin: "disabled", updatedAt: "t", updatedBy: "r" },
      "r",
    );
    expect(await settings.loadAuthSettings()).toMatchObject({ entraEnabled: false, localLogin: "admin-only" });
  });

  test("no store and a broken store both fall back to the environment", async () => {
    handle.mode = "none";
    expect((await settings.loadAuthSettings()).source).toBe("env");
    handle.mode = "broken";
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await settings.loadAuthSettings()).source).toBe("env");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("the login page's providers follow the switch and the build-time OIDC mode", async () => {
    expect(await settings.loginProviders()).toEqual({ entra: false, local: true, localAdminOnly: false, oidc: false });
    configureEntra();
    process.env.STORAGEBASE_ENTRA_ENABLED = "1";
    process.env.STORAGEBASE_LOCAL_LOGIN = "admin-only";
    expect(await settings.loginProviders()).toEqual({ entra: true, local: true, localAdminOnly: true, oidc: false });
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    expect((await settings.loginProviders()).local).toBe(false);
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    expect(await settings.loginProviders()).toMatchObject({ oidc: true, local: false });
  });
});

describe("saving the switch", () => {
  test("validates the body and refuses without a store", async () => {
    await expect(settings.saveAuthSettings({ entraEnabled: "yes", localLogin: "enabled" }, "root")).rejects.toThrow(
      "entraEnabled",
    );
    await expect(settings.saveAuthSettings({ entraEnabled: false, localLogin: "off" }, "root")).rejects.toThrow(
      "localLogin",
    );
    await expect(settings.saveAuthSettings(null, "root")).rejects.toThrow("entraEnabled");
    handle.mode = "none";
    await expect(
      settings.saveAuthSettings({ entraEnabled: false, localLogin: "enabled" }, "root"),
    ).rejects.toMatchObject({
      code: "ACCESS_STORE_UNAVAILABLE",
    });
  });

  test("Entra cannot be turned on unconfigured, or without a recent successful test", async () => {
    await expect(settings.saveAuthSettings({ entraEnabled: true, localLogin: "enabled" }, "root")).rejects.toThrow(
      "Microsoft Entra is not configured",
    );
    configureEntra();
    await expect(settings.saveAuthSettings({ entraEnabled: true, localLogin: "enabled" }, "root", NOW)).rejects.toThrow(
      "Run a successful test sign-in",
    );
    await settings.recordEntraTest({ ok: false, at: new Date(NOW).toISOString(), by: "root", error: "oidc_failed" });
    await expect(settings.saveAuthSettings({ entraEnabled: true, localLogin: "enabled" }, "root", NOW)).rejects.toThrow(
      "Run a successful test sign-in",
    );
    await settings.recordEntraTest({
      ok: true,
      at: new Date(NOW - settings.ENTRA_TEST_VALIDITY_MS - 1).toISOString(),
      by: "root",
    });
    await expect(settings.saveAuthSettings({ entraEnabled: true, localLogin: "enabled" }, "root", NOW)).rejects.toThrow(
      "Run a successful test sign-in",
    );
  });

  test("a recent successful test lets Entra on; saving again needs no second test", async () => {
    configureEntra();
    await settings.recordEntraTest({ ok: true, at: new Date(NOW - 1000).toISOString(), by: "root" });
    const { before, after } = await settings.saveAuthSettings(
      { entraEnabled: true, localLogin: "admin-only" },
      "root",
      NOW,
    );
    expect(before).toMatchObject({ entraEnabled: false, source: "env" });
    expect(after).toEqual({
      entraEnabled: true,
      localLogin: "admin-only",
      source: "store",
      updatedAt: new Date(NOW).toISOString(),
      updatedBy: "root",
    });
    await handle.store.setSetting("access:entra-test", null, "root");
    const again = await settings.saveAuthSettings({ entraEnabled: true, localLogin: "disabled" }, "root", NOW);
    expect(again.after.localLogin).toBe("disabled");
  });

  test("turning Entra off while local sign-in is disabled saves admin-only", async () => {
    const { after } = await settings.saveAuthSettings({ entraEnabled: false, localLogin: "disabled" }, "root", NOW);
    expect(after.localLogin).toBe("admin-only");
  });

  test("the test result round-trips and reads null without a store", async () => {
    await settings.recordEntraTest({ ok: true, at: "t", by: "root", claims: { roles: [], studioRole: "user" } });
    expect(await settings.loadEntraTest()).toMatchObject({ ok: true, by: "root" });
    handle.mode = "none";
    expect(await settings.loadEntraTest()).toBeNull();
  });
});

describe("remembered sign-in roles", () => {
  test("newest first, deduplicated, bounded, and a no-op for no roles or no store", async () => {
    await settings.recordSeenRoles([], NOW);
    expect(await settings.loadSeenRoles()).toEqual([]);
    await settings.recordSeenRoles(["A", "B"], NOW);
    await settings.recordSeenRoles(["B"], NOW + 1000);
    expect(await settings.loadSeenRoles()).toEqual([
      { value: "B", lastSeenAt: new Date(NOW + 1000).toISOString() },
      { value: "A", lastSeenAt: new Date(NOW).toISOString() },
    ]);
    await settings.recordSeenRoles(
      Array.from({ length: 250 }, (_, i) => `R${i}`),
      NOW + 2000,
    );
    expect(await settings.loadSeenRoles()).toHaveLength(200);
    handle.mode = "none";
    await settings.recordSeenRoles(["C"], NOW);
    expect(await settings.loadSeenRoles()).toEqual([]);
  });

  test("a failure to remember is a warning, never an error for the sign-in", async () => {
    handle.mode = "broken";
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await settings.recordSeenRoles(["A"], NOW);
      expect(warned).toHaveBeenCalled();
      await handle.reset();
      const failing = spyOn(handle.store, "getSetting").mockImplementation(async () => {
        throw "not an error";
      });
      await settings.recordSeenRoles(["A"], NOW);
      expect(warned).toHaveBeenCalledTimes(2);
      failing.mockRestore();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("the local-login gate", () => {
  test("enabled lets every role finish; admin-only only admins", async () => {
    expect((await localLoginGate("198.51.100.1")).allows("user")).toBe(true);
    process.env.STORAGEBASE_LOCAL_LOGIN = "admin-only";
    const gate = await localLoginGate("198.51.100.1");
    expect(gate.refused).toBeUndefined();
    expect(gate.allows("user")).toBe(false);
    expect(gate.allows("admin")).toBe(true);
  });

  test("disabled refuses before the body is read, with a metered audit line", async () => {
    configureEntra();
    process.env.STORAGEBASE_ENTRA_ENABLED = "true";
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    const gate = await localLoginGate("198.51.100.1");
    expect(gate.allows("admin")).toBe(false);
    expect(gate.refused?.status).toBe(403);
    expect(await gate.refused?.json()).toEqual({ success: false, message: LOCAL_LOGIN_DISABLED_MESSAGE });
    expect(getServerAuditBuffer().getAll()[0]).toMatchObject({ reason: "local_login_disabled", ip: "198.51.100.1" });
    for (let i = 0; i < 100; i++) await localLoginGate("198.51.100.1");
    expect(getServerAuditBuffer().size).toBeLessThan(50);
  });

  test("a broken audit sink does not change the refusal", async () => {
    configureEntra();
    process.env.STORAGEBASE_ENTRA_ENABLED = "true";
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    const audit = await import("@/lib/audit");
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => {
      throw new Error("sink down");
    });
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect((await localLoginGate("198.51.100.9")).refused?.status).toBe(403);
      expect(logged).toHaveBeenCalled();
    } finally {
      emit.mockRestore();
      logged.mockRestore();
    }
  });
});
