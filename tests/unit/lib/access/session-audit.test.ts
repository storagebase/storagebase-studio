import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import * as auditModule from "@/lib/audit";
import { getServerAuditBuffer } from "@/lib/audit";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import {
  accessSubject,
  claimAtPath,
  normalizeAppRoles,
  sessionActor,
  sessionAuditFields,
  sessionProvider,
  sessionRoles,
  MAX_APP_ROLES,
} from "@/lib/access/session";
import { accessAuditFields, attachGrant, grantOf } from "@/lib/access/grant";
import {
  auditAccessChange,
  auditAccessDenial,
  MANAGED_USE_WINDOW_MS,
  recordManagedUse,
  resetManagedUseTracking,
} from "@/lib/access/audit";
import { redactConfig, secretPaths, withoutSeedSecrets } from "@/lib/access/redact";

/**
 * The session readers, the grant carrier, the access audit events and the redacted views
 * (StorageBase fork). Role values are illustrative, never a real tenant's.
 */

const request = { headers: new Headers({ "user-agent": "test-agent", "x-forwarded-for": "198.51.100.7" }) };

beforeEach(() => {
  getServerAuditBuffer().clear();
  clearRateLimitState();
  resetManagedUseTracking();
});

describe("session readers", () => {
  test("app roles are normalised: strings only, trimmed, deduplicated, bounded", () => {
    expect(normalizeAppRoles([" A ", "A", "", 7, "B", "x".repeat(129)])).toEqual(["A", "B"]);
    expect(normalizeAppRoles("Solo")).toEqual(["Solo"]);
    expect(normalizeAppRoles(undefined)).toEqual([]);
    expect(normalizeAppRoles(Array.from({ length: 100 }, (_, i) => `R${i}`))).toHaveLength(MAX_APP_ROLES);
  });

  test("session roles are the Studio role first, then the app roles once", () => {
    expect(sessionRoles({ role: "user", appRoles: ["Team.A.Read", "user"] })).toEqual(["user", "Team.A.Read"]);
    expect(sessionRoles({ role: "admin" })).toEqual(["admin"]);
    expect(accessSubject({ role: "user", appRoles: "bad" as unknown as string[] })).toEqual({
      role: "user",
      appRoles: ["bad"],
    });
  });

  test("provider, actor and the identity audit fields", () => {
    expect(sessionProvider({ role: "user", provider: "entra" })).toBe("entra");
    expect(sessionProvider({ role: "user", provider: "oidc" })).toBe("oidc");
    expect(sessionProvider({ role: "user", provider: "forged" })).toBe("local");
    expect(sessionActor({ role: "user", username: "alice" })).toBe("alice");
    expect(sessionActor({ role: "user" })).toBe("user");
    expect(sessionAuditFields({ role: "user", provider: "entra", oid: "o-1", appRoles: ["A", "B"] })).toEqual({
      authProvider: "entra",
      subject: "o-1",
      appRoles: "A,B",
    });
    expect(sessionAuditFields({ role: "user", oid: "" })).toEqual({ authProvider: "local" });
  });

  test("claim paths navigate dot notation and name nothing when empty or broken", () => {
    const claims = { roles: ["A"], realm_access: { roles: ["B"] }, flat: "x" };
    expect(claimAtPath(claims, "roles")).toEqual(["A"]);
    expect(claimAtPath(claims, "realm_access.roles")).toEqual(["B"]);
    expect(claimAtPath(claims, "flat.deeper")).toBeUndefined();
    expect(claimAtPath(claims, "")).toBeUndefined();
  });
});

describe("the grant carrier", () => {
  const grant = {
    permission: "read" as const,
    via: "binding" as const,
    roles: ["A"],
    groupIds: ["g"],
    groupNames: ["G"],
  };

  test("survives a spread, never survives serialisation, and is absent on anything else", () => {
    const connection = attachGrant({ id: "c", name: "C" }, grant);
    expect(grantOf({ ...connection })).toBe(grant);
    expect(JSON.stringify(connection)).toBe('{"id":"c","name":"C"}');
    expect(grantOf({ id: "c" })).toBeUndefined();
    expect(grantOf(null)).toBeUndefined();
    expect(grantOf("c")).toBeUndefined();
  });

  test("audit fields name the permission, the granting roles and the groups", () => {
    expect(accessAuditFields(attachGrant({}, grant))).toEqual({
      permission: "read",
      grantedBy: "A",
      accessGroups: "G",
    });
    expect(
      accessAuditFields(
        attachGrant({}, { permission: "admin", via: "admin-bypass", roles: [], groupIds: [], groupNames: [] }),
      ),
    ).toEqual({ permission: "admin", grantedBy: "admin-bypass" });
    expect(accessAuditFields({})).toEqual({});
  });
});

describe("access audit events", () => {
  test("a denial names the caller, the reason, the connection and the grant", () => {
    const connection = attachGrant(
      { id: "managed:v", name: "Vault", type: "azure-key-vault" },
      { permission: "read", via: "binding", roles: ["A"], groupIds: ["g"], groupNames: ["G"] },
    );
    auditAccessDenial({
      session: { role: "user", username: "alice", provider: "entra", appRoles: ["A"] },
      target: "POST /api/resources/secret/write",
      reason: "access_insufficient",
      connection,
      request,
    });
    const [event] = getServerAuditBuffer().getAll();
    expect(event).toMatchObject({
      type: "permission_denied",
      user: "alice",
      role: "user",
      reason: "access_insufficient",
      authProvider: "entra",
      appRoles: "A",
      connectionId: "managed:v",
      engine: "azure-key-vault",
      permission: "read",
      userAgent: "test-agent",
    });
  });

  test("denials are metered per caller, and a bare denial carries no connection", () => {
    for (let i = 0; i < 200; i++)
      auditAccessDenial({ session: { role: "user", username: "bob" }, target: "t", reason: "access_not_granted" });
    const events = getServerAuditBuffer().getAll();
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(200);
    expect(events[0]).not.toHaveProperty("connectionId");
  });

  test("a managed use is recorded once per caller and connection per window", () => {
    const connection = attachGrant(
      { id: "seed:m_o", name: "Orders", type: "postgres" },
      { permission: "admin", via: "admin-bypass", roles: [], groupIds: [], groupNames: [] },
    );
    recordManagedUse({ role: "admin", username: "root" }, connection, 1_000);
    recordManagedUse({ role: "admin", username: "root" }, connection, 2_000);
    recordManagedUse({ role: "user", username: "other" }, connection, 2_000);
    recordManagedUse({ role: "admin", username: "root" }, connection, 1_000 + MANAGED_USE_WINDOW_MS);
    const uses = getServerAuditBuffer().getAll();
    expect(uses.map((event) => event.user)).toEqual(["root", "other", "root"]);
    expect(uses[0]).toMatchObject({ type: "managed_connection", action: "connection.use", grantedBy: "admin-bypass" });
  });

  test("the use tracker is bounded", () => {
    const connection = { id: "c", name: "C", type: "postgres" };
    for (let i = 0; i < 5001; i++) recordManagedUse({ role: "user", username: `u${i}` }, connection, 0);
    recordManagedUse({ role: "user", username: "u0" }, connection, 1);
    expect(getServerAuditBuffer().getAll().at(-1)?.user).toBe("u0");
  });

  test("a change carries its details as JSON and can record a failure", () => {
    auditAccessChange({
      request,
      session: { role: "admin", username: "root" },
      type: "access_config",
      action: "group.create",
      target: "group:g",
      details: { after: { id: "g" } },
    });
    auditAccessChange({
      request,
      session: { role: "admin", username: "root" },
      type: "managed_connection",
      action: "connection.test",
      target: "x",
      failed: true,
    });
    const [created, failed] = getServerAuditBuffer().getAll();
    expect(created).toMatchObject({ type: "access_config", result: "success", details: '{"after":{"id":"g"}}' });
    expect(failed).toMatchObject({ result: "failure" });
    expect(failed).not.toHaveProperty("details");
  });

  test("a broken audit sink is logged, never thrown", () => {
    const emit = spyOn(auditModule, "emitAuditEvent").mockImplementation(() => {
      throw new Error("sink down");
    });
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(() =>
        auditAccessChange({
          request,
          session: { role: "admin", username: "root" },
          type: "access_config",
          action: "a",
          target: "t",
        }),
      ).not.toThrow();
      expect(logged).toHaveBeenCalled();
    } finally {
      emit.mockRestore();
      logged.mockRestore();
    }
  });
});

describe("redacted views", () => {
  test("drop every secret and every unclassified field, and list the secrets that were set", () => {
    const { config, secretsSet } = redactConfig("database", {
      host: "h",
      password: "p",
      sentinelPassword: "",
      connectionString: undefined,
      mystery: "x",
      ssl: { mode: "require", clientKey: "k", junk: 1 },
      sshTunnel: { host: "b", privateKey: "pk", passphrase: null },
    });
    expect(config).toEqual({ host: "h", ssl: { mode: "require" }, sshTunnel: { host: "b" } });
    expect(secretsSet).toEqual(["password", "ssl.clientKey", "sshTunnel.privateKey"]);
    expect(redactConfig("resource", { endpoint: "e", token: "t", ssl: { clientKey: "k" } })).toEqual({
      config: { endpoint: "e" },
      secretsSet: ["token"],
    });
  });

  test("a served Helm seed row loses its Sentinel password and TLS client key, and nothing else", () => {
    expect(
      withoutSeedSecrets({
        id: "seed:r",
        sentinelPassword: "sp",
        sentinels: "a:1",
        ssl: { mode: "require", clientKey: "k", caCert: "c" },
      }),
    ).toEqual({ id: "seed:r", sentinels: "a:1", ssl: { mode: "require", caCert: "c" } } as never);
    expect(withoutSeedSecrets({ id: "seed:p", host: "h" })).toEqual({ id: "seed:p", host: "h" });
    expect(withoutSeedSecrets({ id: "seed:q", ssl: undefined })).toEqual({ id: "seed:q", ssl: undefined });
  });

  test("secret paths cover the root, TLS and tunnel credentials", () => {
    expect(secretPaths("database")).toEqual(
      expect.arrayContaining([
        "password",
        "connectionString",
        "sentinelPassword",
        "ssl.clientKey",
        "sshTunnel.privateKey",
      ]),
    );
    expect(secretPaths("resource")).toEqual(expect.arrayContaining(["secretAccessKey", "token", "sshTunnel.password"]));
  });
});
