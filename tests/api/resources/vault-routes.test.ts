import { describe, test, expect, beforeEach } from "bun:test";
import {
  auditEvents,
  EXCLUSION_KEY,
  factory,
  fakeProvider,
  flags,
  providerCalls,
  request,
  resetHarness,
  session,
  settings,
  store,
} from "./vault-route-harness";
import { parseResponseJSON } from "../../helpers/mock-next";

const routes = {
  objects: (await import("@/app/api/resources/vault/objects/route")).POST,
  object: (await import("@/app/api/resources/vault/object/route")).POST,
  deleted: (await import("@/app/api/resources/vault/deleted/route")).POST,
  "secret/reveal": (await import("@/app/api/resources/vault/secret/reveal/route")).POST,
  "secret/save": (await import("@/app/api/resources/vault/secret/save/route")).POST,
  "key/create": (await import("@/app/api/resources/vault/key/create/route")).POST,
  "certificate/import": (await import("@/app/api/resources/vault/certificate/import/route")).POST,
  "object/delete": (await import("@/app/api/resources/vault/object/delete/route")).POST,
  "deleted/recover": (await import("@/app/api/resources/vault/deleted/recover/route")).POST,
  "deleted/purge": (await import("@/app/api/resources/vault/deleted/purge/route")).POST,
};

type Route = keyof typeof routes;

async function call(route: Route, body: Record<string, unknown>) {
  return routes[route](request(`/api/resources/vault/${route}`, body));
}

function excludeHidden() {
  settings.set(EXCLUSION_KEY, {
    rules: [{ pattern: "hidden-*", kind: "glob", objectType: "any", note: "" }],
  });
}

const PEM = Buffer.from("-----BEGIN CERTIFICATE-----").toString("base64");

describe("vault workbench routes", () => {
  beforeEach(() => resetHarness());

  test("lists, describes and lists deleted items, each audited once with counts only", async () => {
    const listed = await parseResponseJSON<{ objects: Array<{ name: string }> }>(
      await call("objects", { type: "secret" }),
    );
    expect(listed.objects.map((object) => object.name)).toEqual(["db-password", "hidden-secret"]);
    expect(auditEvents[0]).toMatchObject({
      type: "resource_operation",
      action: "vault.list",
      target: "azure-key-vault:secret",
      result: "success",
      counts: { itemsListed: 2, truncated: false },
      userAgent: "vault-test-agent",
    });

    const detail = await call("object", { type: "key", name: "signing" });
    expect(detail.status).toBe(200);
    expect(auditEvents[1]).toMatchObject({
      action: "vault.describe",
      target: "azure-key-vault:key/signing",
      counts: { versionsListed: 0 },
    });

    const deleted = await parseResponseJSON<{ deleted: unknown[] }>(await call("deleted", { type: "secret" }));
    expect(deleted.deleted).toHaveLength(2);
    expect(auditEvents[2]).toMatchObject({ action: "vault.list-deleted", counts: { itemsListed: 2 } });
    expect(auditEvents).toHaveLength(3);
  });

  test("reveal is its own audited read and answers no-store", async () => {
    const res = await call("secret/reveal", { name: "db-password", version: "v7" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({
      name: "db-password",
      value: "TOP-SECRET-VALUE",
      version: "v7",
    });
    expect(auditEvents[0]).toMatchObject({
      action: "vault.secret.reveal",
      target: "azure-key-vault:secret/db-password@v7",
    });
    await call("secret/reveal", { name: "db-password" });
    expect(auditEvents[1]).toMatchObject({ target: "azure-key-vault:secret/db-password" });
    expect((await call("secret/reveal", { name: "db-password", version: "" })).status).toBe(400);
  });

  test("writes pass their parsed input through and record decision + outcome", async () => {
    expect(
      (
        await call("secret/save", {
          name: "db-password",
          value: "new-value",
          contentType: "text/plain",
          tags: { team: "a" },
          expiresOn: "2030-01-01T00:00:00Z",
          enabled: false,
        })
      ).status,
    ).toBe(200);
    await call("secret/save", { name: "db-password", expiresOn: "" });
    await call("key/create", {
      name: "rsa",
      keyType: "RSA",
      keySize: 4096,
      tags: { a: "b" },
      expiresOn: null,
      enabled: true,
    });
    await call("key/create", { name: "ec", keyType: "EC", curve: "P-521" });
    await call("certificate/import", {
      name: "cert",
      contentsBase64: PEM,
      format: "pem",
      password: "",
      tags: { a: "b" },
      enabled: true,
    });
    await call("certificate/import", {
      name: "pfx",
      contentsBase64: "AAEC",
      format: "pkcs12",
      password: "file-password",
    });
    await call("object/delete", { type: "certificate", name: "site-cert" });
    await call("deleted/recover", { type: "secret", name: "old-secret" });
    await call("deleted/purge", { type: "secret", name: "old-secret", confirm: "old-secret" });

    expect(providerCalls.map((entry) => [entry.method, ...entry.args])).toEqual([
      [
        "saveSecret",
        "db-password",
        {
          value: "new-value",
          contentType: "text/plain",
          tags: { team: "a" },
          expiresOn: "2030-01-01T00:00:00.000Z",
          enabled: false,
        },
      ],
      ["saveSecret", "db-password", {}],
      ["createKey", "rsa", { keyType: "RSA", keySize: 4096, tags: { a: "b" }, enabled: true }],
      ["createKey", "ec", { keyType: "EC", curve: "P-521" }],
      ["importCertificate", "cert", { contentsBase64: PEM, format: "pem", tags: { a: "b" }, enabled: true }],
      ["importCertificate", "pfx", { contentsBase64: "AAEC", format: "pkcs12", password: "file-password" }],
      ["deleteVaultObject", "certificate", "site-cert"],
      ["recoverDeletedVaultObject", "secret", "old-secret"],
      ["purgeDeletedVaultObject", "secret", "old-secret"],
    ]);
    expect(auditEvents.map((event) => event.action)).toEqual(
      [
        "vault.secret.save",
        "vault.secret.save",
        "vault.key.create",
        "vault.key.create",
        "vault.certificate.import",
        "vault.certificate.import",
        "vault.delete",
        "vault.recover",
        "vault.purge",
      ].flatMap((action) => [action, action]),
    );
    expect(auditEvents[1].correlationId).toBe(auditEvents[0].correlationId);
    expect(auditEvents[0]).toMatchObject({
      engine: "azure-key-vault",
      connectionId: "res-v",
      userAgent: "vault-test-agent",
    });
  });

  test("a failed write is audited as a failure with its reason", async () => {
    const failing = { ...fakeProvider, saveSecret: async () => Promise.reject(new Error("boom")) };
    factory.provider = failing;
    expect((await call("secret/save", { name: "a", value: "b" })).status).toBe(500);
    expect(auditEvents[1]).toMatchObject({ result: "failure", reason: "resource_failed" });
  });

  test("every body field is validated before the provider is asked", async () => {
    const bad: Array<[Route, Record<string, unknown>]> = [
      ["objects", { type: "blob" }],
      ["object", { type: "secret", name: "" }],
      ["object", { type: "secret", name: "x".repeat(1025) }],
      ["secret/save", { name: "a", value: 5 }],
      ["secret/save", { name: "a", contentType: 5 }],
      ["secret/save", { name: "a", tags: ["x"] }],
      ["secret/save", { name: "a", tags: { a: 1 } }],
      ["secret/save", { name: "a", expiresOn: "not a date" }],
      ["secret/save", { name: "a", enabled: "yes" }],
      ["key/create", { name: "k", keyType: "RSA", keySize: 1024 }],
      ["key/create", { name: "k", keyType: "EC", curve: "P-192" }],
      ["certificate/import", { name: "c", format: "pem" }],
      ["certificate/import", { name: "c", contentsBase64: "***", format: "pem" }],
      ["certificate/import", { name: "c", contentsBase64: "A".repeat(1_400_000), format: "pem" }],
      ["certificate/import", { name: "c", contentsBase64: PEM, format: "der" }],
      ["certificate/import", { name: "c", contentsBase64: PEM, format: "pem", password: 5 }],
      ["deleted/purge", { type: "secret", name: "old-secret", confirm: "old" }],
    ];
    for (const [route, body] of bad) {
      expect((await call(route, body)).status, `${route} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    }
    expect(providerCalls).toHaveLength(0);
  });

  test("an undeclared object type or operation is a 400 the route decides", async () => {
    flags.current = ["tree", "vault.secrets"];
    const keys = await call("objects", { type: "key" });
    expect(keys.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(keys)).error).toContain("holds no keys");
    const reveal = await call("secret/reveal", { name: "db-password" });
    expect((await parseResponseJSON<{ error: string }>(reveal)).error).toContain("vault.secret.reveal");

    // Neither the workbench nor the generic vault surface: refused.
    factory.provider = { getCapabilities: fakeProvider.getCapabilities };
    expect((await call("objects", { type: "secret" })).status).toBe(400);
  });

  test("a provider with only the generic surface is served by the basic workbench", async () => {
    const {
      listVaultObjects: _a,
      describeVaultObject: _b,
      revealSecret: _c,
      saveSecret: _d,
      createKey: _e,
      importCertificate: _f,
      deleteVaultObject: _g,
      listDeletedVaultObjects: _h,
      recoverDeletedVaultObject: _i,
      purgeDeletedVaultObject: _j,
      ...generic
    } = fakeProvider;
    factory.provider = generic;
    const listed = await parseResponseJSON<{ objects: Array<{ name: string }> }>(
      await call("objects", { type: "secret" }),
    );
    expect(listed.objects.map((object) => object.name)).toEqual(["db-password", "hidden-secret"]);
    const revealed = await parseResponseJSON<{ value: string }>(await call("secret/reveal", { name: "db-password" }));
    expect(revealed.value).toBe("legacy-value");
  });

  test("routes require a session", async () => {
    session.current = null;
    expect((await call("objects", { type: "secret" })).status).toBe(401);
  });

  describe("admin exclusion rules are enforced on every route, for admins too", () => {
    beforeEach(() => excludeHidden());

    test("lists and deleted lists drop excluded names", async () => {
      const listed = await parseResponseJSON<{ objects: Array<{ name: string }> }>(
        await call("objects", { type: "secret" }),
      );
      expect(listed.objects.map((object) => object.name)).toEqual(["db-password"]);
      const deleted = await parseResponseJSON<{ deleted: Array<{ name: string }> }>(
        await call("deleted", { type: "secret" }),
      );
      expect(deleted.deleted.map((object) => object.name)).toEqual(["old-secret"]);
    });

    test("every by-name call on an excluded object is a 404 — the provider is never asked", async () => {
      const byName: Array<[Route, Record<string, unknown>]> = [
        ["object", { type: "secret", name: "hidden-secret" }],
        ["secret/reveal", { name: "HIDDEN-secret" }],
        ["secret/save", { name: "hidden-secret", value: "x" }],
        ["key/create", { name: "hidden-key", keyType: "EC", curve: "P-256" }],
        ["certificate/import", { name: "hidden-cert", contentsBase64: PEM, format: "pem" }],
        ["object/delete", { type: "key", name: "hidden-key" }],
        ["deleted/recover", { type: "secret", name: "hidden-old" }],
        ["deleted/purge", { type: "secret", name: "hidden-old", confirm: "hidden-old" }],
      ];
      for (const [route, body] of byName) {
        const res = await call(route, body);
        expect(res.status, route).toBe(404);
        // The same sentence a missing object gets: nothing confirms the rule.
        expect((await parseResponseJSON<{ error: string }>(res)).error).toContain("does not exist");
      }
      expect(providerCalls.filter((entry) => entry.method !== "listVaultObjects")).toHaveLength(0);
    });

    test("an unreadable rule store fails closed", async () => {
      store.mode = "broken";
      const res = await call("objects", { type: "secret" });
      expect(res.status).toBe(502);
      expect((await parseResponseJSON<{ error: string }>(res)).error).toContain("exclusion rules could not be read");
    });
  });
});
