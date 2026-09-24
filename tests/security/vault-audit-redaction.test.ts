import { describe, test, expect, beforeEach } from "bun:test";
import { auditEvents, request, resetHarness } from "../api/resources/vault-route-harness";

/**
 * Secret material never enters the audit trail. Every vault route that
 * carries a value — in its body (save, import, legacy write) or in its
 * answer (reveal, legacy read) — runs here with distinctive values, and the
 * whole recorded trail is searched for them. Names and targets are expected;
 * values, key material, certificate contents and passwords are not.
 */

const SECRET_VALUES = [
  "TOP-SECRET-VALUE", // what reveal answers
  "legacy-value", // what the legacy read answers
  "typed-new-value-7f3a", // a saved value
  "legacy-written-value-9b2c", // a legacy write
  "pfx-file-password-4d1e", // a certificate password
];
const CERTIFICATE = Buffer.from("-----BEGIN PRIVATE KEY-----distinctive-key-material-5e6f").toString("base64");

describe("vault audit redaction", () => {
  beforeEach(() => resetHarness());

  test("no value, password or certificate content appears in any audit event", async () => {
    const vault = (route: string) => import(`@/app/api/resources/vault/${route}/route`);
    const secret = (route: string) => import(`@/app/api/resources/secret/${route}/route`);

    await (await vault("secret/reveal")).POST(request("/api/resources/vault/secret/reveal", { name: "db-password" }));
    await (await vault("secret/save")).POST(
      request("/api/resources/vault/secret/save", { name: "db-password", value: "typed-new-value-7f3a" }),
    );
    await (await vault("certificate/import")).POST(
      request("/api/resources/vault/certificate/import", {
        name: "cert",
        contentsBase64: CERTIFICATE,
        format: "pkcs12",
        password: "pfx-file-password-4d1e",
      }),
    );
    await (await vault("key/create")).POST(
      request("/api/resources/vault/key/create", { name: "k", keyType: "RSA", keySize: 2048 }),
    );
    await (await secret("read")).POST(request("/api/resources/secret/read", { path: "secret/db-password" }));
    await (await secret("write")).POST(
      request("/api/resources/secret/write", { path: "db-password", value: "legacy-written-value-9b2c" }),
    );

    expect(auditEvents.length).toBeGreaterThanOrEqual(11);
    const trail = JSON.stringify(auditEvents);
    for (const value of [...SECRET_VALUES, CERTIFICATE, "distinctive-key-material"]) {
      expect(trail).not.toContain(value);
    }
    // The trail still names what was touched.
    expect(trail).toContain("azure-key-vault:secret/db-password");
    expect(trail).toContain("azure-key-vault:certificate/cert");
  });
});
