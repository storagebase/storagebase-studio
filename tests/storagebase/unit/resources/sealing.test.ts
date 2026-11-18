import { describe, test, expect, beforeEach } from "bun:test";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import {
  openSealedResourceConnection,
  resourceConnectionHasCredential,
  resourceConnectionRow,
  sealResourceConnection,
  sealResourceSecretFields,
  SEALABLE_FIELDS,
} from "@/storagebase/resources/sealing";
import { ResourceConfigError } from "@/storagebase/resources/errors";
import type { ResourceConnection } from "@/storagebase/resources/types";

/**
 * The sealing contract every fork resource connection rides (upstream's
 * AES-GCM envelope, imported): a stored record's secret fields are envelopes
 * the server can open, and a row NEVER carries a secret value — the browser
 * sees a boolean marker instead.
 *
 * The key is set per test process and reset around each case so a change of
 * key material proves what the fork promises about a rotated key: a refusal
 * naming the field, not a silent empty credential.
 */

const KEY = "storagebase-test-encryption-key-0123456789";
const OTHER_KEY = "storagebase-other-encryption-key-9876543210";

const connection = (): ResourceConnection => ({
  id: "res_1",
  name: "Prod Vault",
  type: "hashicorp-vault",
  createdAt: "2026-11-18T00:00:00.000Z",
  endpoint: "https://vault:8200",
  token: "hvs.root-token",
  namespace: "ops",
  clientSecret: "azure-client-secret",
});

beforeEach(() => {
  process.env.STORAGE_ENCRYPTION_KEY = KEY;
  delete process.env.JWT_SECRET;
  resetStorageEncryptionKey();
});

describe("sealResourceConnection", () => {
  test("seals every secret field and leaves addressing facts as they are", () => {
    const sealed = sealResourceConnection(connection());
    expect(sealed.token).toMatch(/^v1:/);
    expect(sealed.clientSecret).toMatch(/^v1:/);
    expect(sealed.endpoint).toBe("https://vault:8200");
    expect(sealed.namespace).toBe("ops");
    expect(sealed.id).toBe("res_1");
    // No plaintext secret anywhere in the stored record.
    expect(JSON.stringify(sealed)).not.toContain("hvs.root-token");
    expect(JSON.stringify(sealed)).not.toContain("azure-client-secret");
  });

  test("an empty secret is dropped, not sealed — the has-credential marker must not be a lie", () => {
    const sealed = sealResourceConnection({ ...connection(), token: "", clientSecret: undefined });
    expect(sealed.token).toBeUndefined();
    expect(sealed.clientSecret).toBeUndefined();
  });

  test("round-trips through openSealedResourceConnection under the same key", () => {
    const opened = openSealedResourceConnection(sealResourceConnection(connection()));
    expect(opened).toEqual(connection());
  });

  test("a plaintext value predating sealing passes through untouched (lazy migration)", () => {
    const opened = openSealedResourceConnection({ ...connection(), token: "legacy-plaintext-token" });
    expect(opened.token).toBe("legacy-plaintext-token");
  });

  test("an envelope another key sealed is a refusal naming the field, never a silent empty", () => {
    const sealed = sealResourceConnection(connection());
    process.env.STORAGE_ENCRYPTION_KEY = OTHER_KEY;
    resetStorageEncryptionKey();
    let refusal: unknown = null;
    try {
      openSealedResourceConnection(sealed);
    } catch (caught) {
      refusal = caught;
    }
    expect(refusal).toBeInstanceOf(ResourceConfigError);
    expect((refusal as ResourceConfigError).code).toBe("SB_RESOURCE_CONFIG_ERROR");
    // Names the FIRST sealed field (the classification's iteration order), and
    // never the value it could not open.
    expect((refusal as Error).message).toContain('"clientSecret"');
    expect((refusal as Error).message).not.toContain("hvs.root-token");
    expect((refusal as Error).message).not.toContain("azure-client-secret");
  });
});

describe("sealResourceSecretFields", () => {
  test("seals only the values it is given — the update path's untouched envelopes pass as they are", () => {
    const sealed = sealResourceSecretFields({ token: "fresh-token", clientSecret: "" });
    expect(Object.keys(sealed)).toEqual(["token"]);
    expect(sealed.token).toMatch(/^v1:/);
  });
});

describe("the row the browser may hold", () => {
  test("carries non-secret fields and a has-credential marker, never a secret value", () => {
    const row = resourceConnectionRow(connection());
    expect(row).toEqual({
      id: "res_1",
      name: "Prod Vault",
      type: "hashicorp-vault",
      createdAt: "2026-11-18T00:00:00.000Z",
      endpoint: "https://vault:8200",
      namespace: "ops",
      hasCredential: true,
    });
    expect(JSON.stringify(row)).not.toContain("hvs.root-token");
    expect(JSON.stringify(row)).not.toContain("azure-client-secret");
  });

  test("marks a seeded row with the permission the entry's roles grant", () => {
    const row = resourceConnectionRow(connection(), { permission: "write" });
    expect(row.seeded).toBe(true);
    expect(row.permission).toBe("write");
  });

  test("hasCredential answers from the one secret classification, empty strings included", () => {
    expect(resourceConnectionHasCredential(connection())).toBe(true);
    expect(resourceConnectionHasCredential({ ...connection(), token: "", clientSecret: undefined })).toBe(false);
    // An addressing-only connection carries no credential to seal.
    expect(resourceConnectionHasCredential({ ...connection(), token: undefined, clientSecret: undefined })).toBe(false);
    // Every field the marker reads is one sealing seals.
    expect(SEALABLE_FIELDS.length).toBe(8);
  });
});
