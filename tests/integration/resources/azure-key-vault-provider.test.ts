import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import {
  ResourceConfigError,
  ResourceConflictError,
  ResourceConnectionError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
} from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * Azure Key Vault provider tests. The three SDKs and @azure/identity are
 * doubled with mock.module; shapes follow the SDKs' documented contracts (no
 * emulator exists — the documented limitation — so these stay mock-anchored,
 * unlike the fixture families):
 * - listPropertiesOf{Secrets,Keys,Certificates} page property objects; the
 *   version lists page one entry per version; the deleted lists page
 *   `properties.{deletedOn, scheduledPurgeDate}` (secrets, keys) or top-level
 *   fields (certificates).
 * - getSecret answers `{value, properties}`; missing answers 404 with code
 *   SecretNotFound (KeyNotFound / CertificateNotFound for the others).
 * - Delete is begin + pollUntilDone and NOTHING else: purge is its own call.
 * - The fake counts every getSecret, so "opening a secret never reads its
 *   value" is asserted, not assumed.
 */

interface FakeVersion {
  version: string;
  value?: string;
  enabled?: boolean;
  createdOn: Date;
  updatedOn?: Date;
  expiresOn?: Date;
  notBefore?: Date;
  contentType?: string;
  tags?: Record<string, string>;
  recoveryLevel?: string;
}

interface FakeObject {
  versions: FakeVersion[];
  deleted: boolean;
  keyType?: string;
  n?: Uint8Array;
  crv?: string;
  keyOperations?: string[];
  subject?: string;
  issuer?: string;
  thumbprint?: Uint8Array;
}

type Kind = "secret" | "key" | "certificate";

const vault: Record<Kind, Record<string, FakeObject>> = { secret: {}, key: {}, certificate: {} };
const calls: Array<{ method: string; args: unknown[] }> = [];
/** Per-method injected failures: thrown by that SDK method. */
const failures: Record<string, unknown> = {};

function track(method: string, ...args: unknown[]) {
  calls.push({ method, args });
  if (method in failures) throw failures[method];
}

function notFound(kind: Kind, name: string) {
  const code = { secret: "SecretNotFound", key: "KeyNotFound", certificate: "CertificateNotFound" }[kind];
  const error = new Error(`${kind} ${name} not found`) as Error & { status?: number; code?: string };
  error.status = 404;
  error.code = code;
  return error;
}

function live(kind: Kind, name: string): FakeObject {
  const object = vault[kind][name];
  if (!object || object.deleted) throw notFound(kind, name);
  return object;
}

function current(object: FakeObject): FakeVersion {
  return [...object.versions].sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())[0];
}

function propertiesOf(name: string, version: FakeVersion, extra: Record<string, unknown> = {}) {
  const { value: _value, ...properties } = version;
  return { name, ...properties, ...extra };
}

async function* page<T>(items: T[]) {
  for (const item of items) yield item;
}

const done = <T>(result?: T) => ({ pollUntilDone: async () => result });

class FakeCredential {
  constructor(
    public readonly tenant: string,
    public readonly client: string,
    public readonly secret: string,
  ) {}
}

class FakeSecretClient {
  static lastArgs: unknown = null;
  constructor(
    private readonly url: string,
    credential: FakeCredential,
  ) {
    FakeSecretClient.lastArgs = { url, credential };
  }
  listPropertiesOfSecrets() {
    if (this.url.includes("localhost:1")) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:1");
          },
        }),
      };
    }
    track("listPropertiesOfSecrets");
    return page(
      Object.entries(vault.secret)
        .filter(([, object]) => !object.deleted)
        .map(([name, object]) => propertiesOf(name, current(object), { version: undefined })),
    );
  }
  listPropertiesOfSecretVersions(name: string) {
    track("listPropertiesOfSecretVersions", name);
    const object = vault.secret[name];
    return page(object && !object.deleted ? object.versions.map((version) => propertiesOf(name, version)) : []);
  }
  async getSecret(name: string, options: { version?: string } = {}) {
    track("getSecret", name, options);
    const object = live("secret", name);
    const version =
      options.version === undefined
        ? current(object)
        : (object.versions.find((entry) => entry.version === options.version) as FakeVersion);
    return { value: version.value, properties: propertiesOf(name, version) };
  }
  async setSecret(name: string, value: string, options: Record<string, unknown> = {}) {
    track("setSecret", name, value, options);
    const object = vault.secret[name] ?? { versions: [], deleted: false };
    object.versions.push({
      version: `v${object.versions.length + 1}`,
      value,
      createdOn: new Date(Date.UTC(2026, 5, 1 + object.versions.length)),
      ...options,
    });
    vault.secret[name] = object;
    return {};
  }
  async updateSecretProperties(name: string, version: string, options: Record<string, unknown>) {
    track("updateSecretProperties", name, version, options);
    return {};
  }
  async beginDeleteSecret(name: string) {
    track("beginDeleteSecret", name);
    live("secret", name).deleted = true;
    return done();
  }
  listDeletedSecrets() {
    track("listDeletedSecrets");
    return page(
      Object.entries(vault.secret)
        .filter(([, object]) => object.deleted)
        .map(([name]) => ({
          properties: {
            name,
            deletedOn: new Date("2026-09-01T00:00:00.000Z"),
            scheduledPurgeDate: new Date("2026-12-01T00:00:00.000Z"),
          },
        })),
    );
  }
  async beginRecoverDeletedSecret(name: string) {
    track("beginRecoverDeletedSecret", name);
    const object = vault.secret[name];
    if (object) object.deleted = false;
    return done();
  }
  async purgeDeletedSecret(name: string) {
    track("purgeDeletedSecret", name);
    delete vault.secret[name];
  }
}

class FakeKeyClient {
  constructor(public readonly url: string) {}
  listPropertiesOfKeys() {
    track("listPropertiesOfKeys");
    return page(
      Object.entries(vault.key)
        .filter(([, object]) => !object.deleted)
        .map(([name, object]) => propertiesOf(name, current(object))),
    );
  }
  async getKey(name: string) {
    track("getKey", name);
    const object = live("key", name);
    return {
      name,
      keyType: object.keyType,
      keyOperations: object.keyOperations,
      key: { ...(object.n ? { n: object.n } : {}), ...(object.crv ? { crv: object.crv } : {}) },
      properties: propertiesOf(name, current(object)),
    };
  }
  listPropertiesOfKeyVersions(name: string) {
    track("listPropertiesOfKeyVersions", name);
    return page(live("key", name).versions.map((version) => propertiesOf(name, version)));
  }
  async createRsaKey(name: string, options: Record<string, unknown>) {
    track("createRsaKey", name, options);
    return {};
  }
  async createEcKey(name: string, options: Record<string, unknown>) {
    track("createEcKey", name, options);
    return {};
  }
  async beginDeleteKey(name: string) {
    track("beginDeleteKey", name);
    live("key", name).deleted = true;
    return done();
  }
  listDeletedKeys() {
    track("listDeletedKeys");
    return page(
      Object.entries(vault.key)
        .filter(([, object]) => object.deleted)
        .map(([name]) => ({ name, properties: { name, deletedOn: new Date("2026-09-02T00:00:00.000Z") } })),
    );
  }
  async beginRecoverDeletedKey(name: string) {
    track("beginRecoverDeletedKey", name);
    return done();
  }
  async purgeDeletedKey(name: string) {
    track("purgeDeletedKey", name);
  }
}

class FakeCertificateClient {
  constructor(public readonly url: string) {}
  listPropertiesOfCertificates() {
    track("listPropertiesOfCertificates");
    return page(
      Object.entries(vault.certificate)
        .filter(([, object]) => !object.deleted)
        .map(([name, object]) => propertiesOf(name, current(object), { x509Thumbprint: object.thumbprint })),
    );
  }
  async getCertificatePolicy(name: string) {
    track("getCertificatePolicy", name);
    const object = live("certificate", name);
    return { subject: object.subject, issuerName: object.issuer };
  }
  async getCertificate(name: string) {
    track("getCertificate", name);
    const object = live("certificate", name);
    return {
      name,
      properties: propertiesOf(name, current(object), { x509Thumbprint: object.thumbprint }),
      policy: object.subject ? { subject: object.subject, issuerName: object.issuer } : undefined,
    };
  }
  listPropertiesOfCertificateVersions(name: string) {
    track("listPropertiesOfCertificateVersions", name);
    return page(live("certificate", name).versions.map((version) => propertiesOf(name, version)));
  }
  async importCertificate(name: string, bytes: Uint8Array, options: Record<string, unknown>) {
    track("importCertificate", name, Buffer.from(bytes).toString(), options);
    return {};
  }
  async beginDeleteCertificate(name: string) {
    track("beginDeleteCertificate", name);
    live("certificate", name).deleted = true;
    return done();
  }
  listDeletedCertificates() {
    track("listDeletedCertificates");
    return page(
      Object.entries(vault.certificate)
        .filter(([, object]) => object.deleted)
        .map(([name]) => ({ name, scheduledPurgeDate: new Date("2026-12-03T00:00:00.000Z") })),
    );
  }
  async beginRecoverDeletedCertificate(name: string) {
    track("beginRecoverDeletedCertificate", name);
    return done();
  }
  async purgeDeletedCertificate(name: string) {
    track("purgeDeletedCertificate", name);
  }
}

mock.module("@azure/keyvault-secrets", () => ({ SecretClient: FakeSecretClient }));
mock.module("@azure/keyvault-keys", () => ({ KeyClient: FakeKeyClient }));
mock.module("@azure/keyvault-certificates", () => ({ CertificateClient: FakeCertificateClient }));
mock.module("@azure/identity", () => ({ ClientSecretCredential: FakeCredential }));

// Importing the module self-registers the loader, like production.
const { AzureKeyVaultProvider, KEY_VAULT_ENRICH_LIMIT, KEY_VAULT_LIST_LIMIT, KEY_VAULT_VERSION_LIMIT } = await import(
  "@/lib/resources/providers/vaults/azure-key-vault"
);

const connection: ResourceConnection = {
  id: "res-1",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "example-vault",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "client-credential",
};

function seed() {
  for (const kind of ["secret", "key", "certificate"] as const) {
    for (const name of Object.keys(vault[kind])) delete vault[kind][name];
  }
  for (const method of Object.keys(failures)) delete failures[method];
  calls.length = 0;
  vault.secret["db-password"] = {
    deleted: false,
    versions: [
      { version: "v1", value: "old-value", createdOn: new Date("2026-01-01T00:00:00.000Z"), enabled: false },
      {
        version: "v2",
        value: "s3cret",
        createdOn: new Date("2026-02-01T00:00:00.000Z"),
        updatedOn: new Date("2026-02-02T00:00:00.000Z"),
        expiresOn: new Date("2027-01-01T00:00:00.000Z"),
        enabled: true,
        contentType: "text/plain",
        tags: { team: "platform" },
        recoveryLevel: "Recoverable+Purgeable",
      },
    ],
  };
  vault.key["signing"] = {
    deleted: false,
    keyType: "RSA",
    n: new Uint8Array(256),
    keyOperations: ["sign", "verify"],
    versions: [{ version: "k1", createdOn: new Date("2026-03-01T00:00:00.000Z"), enabled: true }],
  };
  vault.key["ec-key"] = {
    deleted: false,
    keyType: "EC",
    crv: "P-256",
    versions: [{ version: "k2", createdOn: new Date("2026-03-02T00:00:00.000Z") }],
  };
  vault.certificate["site-cert"] = {
    deleted: false,
    subject: "CN=example.test",
    issuer: "Self",
    thumbprint: new Uint8Array([0xab, 0x01]),
    versions: [
      {
        version: "c1",
        createdOn: new Date("2026-04-01T00:00:00.000Z"),
        notBefore: new Date("2026-04-01T00:00:00.000Z"),
        expiresOn: new Date("2027-04-01T00:00:00.000Z"),
      },
    ],
  };
}

function called(method: string) {
  return calls.filter((entry) => entry.method === method);
}

describe("AzureKeyVaultProvider", () => {
  beforeEach(() => {
    seed();
    FakeSecretClient.lastArgs = null;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("azure-key-vault");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(AzureKeyVaultProvider);
  });

  test("refuses a connection with no vault or no credential set", () => {
    expect(() => new AzureKeyVaultProvider({ ...connection, vaultName: undefined })).toThrow(ResourceConfigError);
    expect(() => new AzureKeyVaultProvider({ ...connection, clientSecret: undefined })).toThrow(ResourceConfigError);
  });

  test("builds the vault URL from the vault name with Entra credentials", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(FakeSecretClient.lastArgs).toMatchObject({ url: "https://example-vault.vault.azure.net" });
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
  });

  test("health answers through the secret listing", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    expect((await provider.getHealth()).status).toBe("healthy");
  });

  test("a refusing endpoint surfaces as a connection error", async () => {
    const provider = new AzureKeyVaultProvider({ ...connection, endpoint: "http://localhost:1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("lists secrets as roots", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({ id: "secret/db-password", kind: "secret", name: "db-password" });
    expect(await provider.listNodes("secret/db-password")).toEqual({ nodes: [], truncated: false });
    expect((await provider.listSecrets("", "zzz")).nodes).toHaveLength(0);
  });

  test("reads values with versions", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const read = await provider.readSecret("secret/db-password");
    expect(read.value).toBe("s3cret");
    expect(read.metadata?.version).toBe("v2");
  });

  test("a missing secret is a 404, other read failures a connection error", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    expect(await provider.readSecret("nope").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
    failures.getSecret = new Error("socket closed");
    expect(await provider.readSecret("db-password").catch((e: unknown) => e)).toBeInstanceOf(ResourceConnectionError);
  });

  test("writes set values", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.writeSecret("secret/new", "fresh");
    expect(vault.secret.new?.versions[0].value).toBe("fresh");
    failures.setSecret = new Error("throttled");
    expect(await provider.writeSecret("x", "y").catch((e: unknown) => e)).toBeInstanceOf(ResourceConnectionError);
  });

  test("the legacy delete is a SOFT delete: no purge follows", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.deleteSecret("secret/db-password");
    expect(vault.secret["db-password"].deleted).toBe(true);
    expect(called("purgeDeletedSecret")).toHaveLength(0);

    expect(await provider.deleteSecret("secret/db-password").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
    failures.beginDeleteSecret = new Error("forbidden");
    expect(await provider.deleteSecret("x").catch((e: unknown) => e)).toBeInstanceOf(ResourceConnectionError);
  });

  test("capabilities declare the generic surface and the full workbench", () => {
    const provider = new AzureKeyVaultProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "vault", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toEqual([
      "tree",
      "secret.read",
      "secret.write",
      "secret.delete",
      "vault.secrets",
      "vault.keys",
      "vault.certificates",
      "vault.secret.reveal",
      "vault.secret.write",
      "vault.secret.metadata",
      "vault.key.write",
      "vault.certificate.write",
      "vault.delete",
      "vault.soft-delete",
    ]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Vault", itemNoun: "Secrets" });
  });
});

describe("AzureKeyVaultProvider workbench", () => {
  beforeEach(() => seed());

  test("secret listing carries metadata and never a value", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const listing = await provider.listVaultObjects("secret");
    expect(listing.truncated).toBe(false);
    expect(listing.objects[0]).toMatchObject({
      type: "secret",
      name: "db-password",
      enabled: true,
      contentType: "text/plain",
      expiresOn: "2027-01-01T00:00:00.000Z",
      updatedOn: "2026-02-02T00:00:00.000Z",
      tags: { team: "platform" },
    });
    expect(JSON.stringify(listing)).not.toContain("s3cret");
    expect(called("getSecret")).toHaveLength(0);
  });

  test("a listing stops at the bound and says so", async () => {
    for (let index = 0; index <= KEY_VAULT_LIST_LIMIT; index += 1) {
      vault.secret[`s-${index}`] = { deleted: false, versions: [{ version: "v", createdOn: new Date(0) }] };
    }
    const provider = new AzureKeyVaultProvider(connection);
    const listing = await provider.listVaultObjects("secret");
    expect(listing.truncated).toBe(true);
    expect(listing.objects).toHaveLength(KEY_VAULT_LIST_LIMIT);
  });

  test("secret detail comes from the version list — opening a secret never reads its value", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const detail = await provider.describeVaultObject("secret", "db-password");
    expect(detail).toMatchObject({
      version: "v2",
      recoveryLevel: "Recoverable+Purgeable",
      contentType: "text/plain",
      keyOperations: [],
      versionsTruncated: false,
    });
    expect(detail.versions.map((version) => version.version)).toEqual(["v2", "v1"]);
    expect(detail.versions[1]).toMatchObject({ enabled: false, expiresOn: null });
    expect(JSON.stringify(detail)).not.toContain("s3cret");
    expect(called("getSecret")).toHaveLength(0);

    expect(await provider.describeVaultObject("secret", "nope").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test("version history stops at its bound", async () => {
    vault.secret.many = {
      deleted: false,
      versions: Array.from({ length: KEY_VAULT_VERSION_LIMIT + 1 }, (_, index) => ({
        version: `v${index}`,
        createdOn: new Date(index * 1000),
      })),
    };
    const provider = new AzureKeyVaultProvider(connection);
    const detail = await provider.describeVaultObject("secret", "many");
    expect(detail.versionsTruncated).toBe(true);
  });

  test("reveal is the one call that reads a value, current or a given version", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    expect(await provider.revealSecret("db-password")).toEqual({ name: "db-password", value: "s3cret", version: "v2" });
    expect(await provider.revealSecret("db-password", "v1")).toEqual({
      name: "db-password",
      value: "old-value",
      version: "v1",
    });
    expect(called("getSecret")[1].args[1]).toEqual({ version: "v1" });
    expect(await provider.revealSecret("nope").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
  });

  test("saving with a value adds a version with its properties; without one, updates properties in place", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.saveSecret("db-password", {
      value: "rotated",
      contentType: "text/plain",
      tags: { team: "a" },
      expiresOn: "2028-01-01T00:00:00.000Z",
      enabled: true,
    });
    expect(called("setSecret")[0].args).toEqual([
      "db-password",
      "rotated",
      {
        contentType: "text/plain",
        tags: { team: "a" },
        expiresOn: new Date("2028-01-01T00:00:00.000Z"),
        enabled: true,
      },
    ]);

    await provider.saveSecret("db-password", { enabled: false });
    // The newest version is v3 (the one just added); its value is never read.
    expect(called("updateSecretProperties")[0].args).toEqual(["db-password", "v3", { enabled: false }]);
    expect(called("getSecret")).toHaveLength(0);

    await provider.saveSecret("fresh", { value: "x" });
    expect(called("setSecret")[1].args).toEqual(["fresh", "x", {}]);

    expect(await provider.saveSecret("nope", { enabled: true }).catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test("keys list with type and size or curve, enriched best effort", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const listing = await provider.listVaultObjects("key");
    const byName = Object.fromEntries(listing.objects.map((object) => [object.name, object]));
    expect(byName.signing).toMatchObject({ keyType: "RSA", keySize: 2048, curve: null, enabled: true });
    expect(byName["ec-key"]).toMatchObject({ keyType: "EC", keySize: null, curve: "P-256" });

    failures.getKey = new Error("forbidden");
    const degraded = await provider.listVaultObjects("key");
    expect(degraded.objects[0]).toMatchObject({ keyType: null, keySize: null });
  });

  test("key enrichment stops at its bound", async () => {
    for (let index = 0; index < KEY_VAULT_ENRICH_LIMIT; index += 1) {
      vault.key[`a-${String(index).padStart(3, "0")}`] = {
        deleted: false,
        keyType: "RSA",
        n: new Uint8Array(512),
        versions: [{ version: "k", createdOn: new Date(0) }],
      };
    }
    const provider = new AzureKeyVaultProvider(connection);
    const listing = await provider.listVaultObjects("key");
    expect(listing.objects.filter((object) => object.keyType === null)).toHaveLength(2);
  });

  test("key detail carries permitted operations and versions", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const detail = await provider.describeVaultObject("key", "signing");
    expect(detail).toMatchObject({ keyType: "RSA", keySize: 2048, keyOperations: ["sign", "verify"], version: "k1" });
    expect(detail.versions).toHaveLength(1);
    const ec = await provider.describeVaultObject("key", "ec-key");
    expect(ec).toMatchObject({ keyOperations: [], recoveryLevel: null });
  });

  test("keys are created RSA with a size or EC with a curve", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.createKey("rsa-new", {
      keyType: "RSA",
      keySize: 3072,
      tags: { a: "b" },
      expiresOn: "2030-01-01T00:00:00.000Z",
      enabled: false,
    });
    expect(called("createRsaKey")[0].args).toEqual([
      "rsa-new",
      { tags: { a: "b" }, expiresOn: new Date("2030-01-01T00:00:00.000Z"), enabled: false, keySize: 3072 },
    ]);
    await provider.createKey("ec-new", { keyType: "EC", curve: "P-384" });
    expect(called("createEcKey")[0].args).toEqual(["ec-new", { curve: "P-384" }]);
  });

  test("certificates list with subject, issuer and thumbprint; detail too", async () => {
    vault.certificate.bare = { deleted: false, versions: [{ version: "c2", createdOn: new Date(0) }] };
    const provider = new AzureKeyVaultProvider(connection);
    const listing = await provider.listVaultObjects("certificate");
    const byName = Object.fromEntries(listing.objects.map((object) => [object.name, object]));
    expect(byName["site-cert"]).toMatchObject({
      subject: "CN=example.test",
      issuer: "Self",
      thumbprint: "AB01",
      notBefore: "2026-04-01T00:00:00.000Z",
    });
    expect(byName.bare).toMatchObject({ subject: null, issuer: null, thumbprint: null });

    failures.getCertificatePolicy = new Error("forbidden");
    expect((await provider.listVaultObjects("certificate")).objects[0].subject).toBeNull();

    const detail = await provider.describeVaultObject("certificate", "site-cert");
    expect(detail).toMatchObject({ subject: "CN=example.test", thumbprint: "AB01", version: "c1" });
    expect((await provider.describeVaultObject("certificate", "bare")).subject).toBeNull();
  });

  test("certificates import PEM or PKCS#12 with their content type, password and tags", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.importCertificate("pem-cert", {
      contentsBase64: Buffer.from("-----BEGIN CERTIFICATE-----").toString("base64"),
      format: "pem",
    });
    expect(called("importCertificate")[0].args).toEqual([
      "pem-cert",
      "-----BEGIN CERTIFICATE-----",
      { policy: { contentType: "application/x-pem-file" } },
    ]);
    await provider.importCertificate("pfx-cert", {
      contentsBase64: "AAEC",
      format: "pkcs12",
      password: "file-password",
      tags: { env: "test" },
      enabled: true,
    });
    expect(called("importCertificate")[1].args[2]).toEqual({
      password: "file-password",
      tags: { env: "test" },
      enabled: true,
      policy: { contentType: "application/x-pkcs12" },
    });
  });

  test("delete is soft for every type; deleted items list, recover and purge", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.deleteVaultObject("secret", "db-password");
    await provider.deleteVaultObject("key", "signing");
    await provider.deleteVaultObject("certificate", "site-cert");
    expect(called("purgeDeletedSecret")).toHaveLength(0);

    expect(await provider.listDeletedVaultObjects("secret")).toEqual([
      {
        type: "secret",
        name: "db-password",
        deletedOn: "2026-09-01T00:00:00.000Z",
        scheduledPurgeDate: "2026-12-01T00:00:00.000Z",
      },
    ]);
    expect(await provider.listDeletedVaultObjects("key")).toEqual([
      { type: "key", name: "signing", deletedOn: "2026-09-02T00:00:00.000Z", scheduledPurgeDate: null },
    ]);
    expect(await provider.listDeletedVaultObjects("certificate")).toEqual([
      { type: "certificate", name: "site-cert", deletedOn: null, scheduledPurgeDate: "2026-12-03T00:00:00.000Z" },
    ]);

    for (const type of ["secret", "key", "certificate"] as const) {
      await provider.recoverDeletedVaultObject(type, "x");
      await provider.purgeDeletedVaultObject(type, "x");
    }
    expect(calls.map((entry) => entry.method)).toEqual(
      expect.arrayContaining([
        "beginRecoverDeletedSecret",
        "beginRecoverDeletedKey",
        "beginRecoverDeletedCertificate",
        "purgeDeletedSecret",
        "purgeDeletedKey",
        "purgeDeletedCertificate",
      ]),
    );
  });

  test("service refusals map to 404 / 409 / 400 / 502", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const shaped = (status: number) => Object.assign(new Error(`status ${status}`), { status });
    failures.purgeDeletedSecret = shaped(409);
    expect(await provider.purgeDeletedVaultObject("secret", "a").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceConflictError,
    );
    failures.createRsaKey = Object.assign(new Error("bad size"), { statusCode: 400 });
    expect(await provider.createKey("k", { keyType: "RSA", keySize: 2048 }).catch((e: unknown) => e)).toBeInstanceOf(
      ResourceInvalidRequestError,
    );
    failures.importCertificate = Object.assign(new Error("gone"), { code: "NotFound" });
    expect(
      await provider.importCertificate("c", { contentsBase64: "AA==", format: "pem" }).catch((e: unknown) => e),
    ).toBeInstanceOf(ResourceNotFoundError);
    failures.listPropertiesOfKeys = "socket hang up";
    expect(await provider.listVaultObjects("key").catch((e: unknown) => e)).toBeInstanceOf(ResourceConnectionError);
    for (const [method, run] of [
      ["listDeletedSecrets", () => provider.listDeletedVaultObjects("secret")],
      ["beginRecoverDeletedKey", () => provider.recoverDeletedVaultObject("key", "k")],
      ["beginDeleteCertificate", () => provider.deleteVaultObject("certificate", "c")],
      ["getCertificate", () => provider.describeVaultObject("certificate", "c")],
    ] as const) {
      failures[method] = new Error("down");
      expect(await run().catch((e: unknown) => e)).toBeInstanceOf(ResourceConnectionError);
    }
  });
});
