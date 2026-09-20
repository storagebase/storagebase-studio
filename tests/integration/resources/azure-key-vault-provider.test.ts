import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * Azure Key Vault provider tests. Both SDKs are doubled with mock.module;
 * shapes follow the SDK's documented contracts (no emulator exists — the
 * documented limitation — so these stay mock-anchored, unlike the fixture
 * families):
 * - listPropertiesOfSecrets pages `{name, enabled, updatedOn}`.
 * - getSecret answers `{value, properties: {version, createdOn}}`; missing
 *   answers 404 with code SecretNotFound.
 * - Delete is begin + pollUntilDone + purge: soft-delete alone would leave
 *   the secret recoverable while reported gone.
 */

const secrets: Record<string, { value: string; version: string; deleted: boolean }> = {};

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
  async *listPropertiesOfSecrets() {
    if (this.url.includes("localhost:1")) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    for (const [name, secret] of Object.entries(secrets)) {
      if (secret.deleted) continue;
      yield { name, enabled: true, updatedOn: new Date("2026-09-19T23:40:58.000Z") };
    }
  }
  async getSecret(name: string) {
    const secret = secrets[name];
    if (!secret || secret.deleted) {
      const error = new Error(`Secret ${name} not found`) as Error & { status?: number; code?: string };
      error.status = 404;
      error.code = "SecretNotFound";
      throw error;
    }
    return {
      value: secret.value,
      properties: { version: secret.version, createdOn: new Date("2026-09-19T23:40:58.000Z") },
    };
  }
  async setSecret(name: string, value: string) {
    secrets[name] = { value, version: `v${Object.keys(secrets).length}`, deleted: false };
    return {};
  }
  async beginDeleteSecret(name: string) {
    const secret = secrets[name];
    if (!secret || secret.deleted) {
      const error = new Error(`Secret ${name} not found`) as Error & { status?: number; code?: string };
      error.status = 404;
      error.code = "SecretNotFound";
      throw error;
    }
    secret.deleted = true;
    return { pollUntilDone: async () => undefined };
  }
  async purgeDeletedSecret(_name: string) {
    purged.push(_name);
  }
}

const purged: string[] = [];

mock.module("@azure/keyvault-secrets", () => ({ SecretClient: FakeSecretClient }));
mock.module("@azure/identity", () => ({ ClientSecretCredential: FakeCredential }));

// Importing the module self-registers the loader, like production.
const { AzureKeyVaultProvider } = await import("@/lib/resources/providers/vaults/azure-key-vault");

const connection: ResourceConnection = {
  id: "res-1",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "myvault",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
};

function seed() {
  for (const key of Object.keys(secrets)) delete secrets[key];
  secrets["db-password"] = { value: "s3cret", version: "v1", deleted: false };
}

describe("AzureKeyVaultProvider", () => {
  beforeEach(() => {
    seed();
    purged.length = 0;
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
    expect(FakeSecretClient.lastArgs).toMatchObject({ url: "https://myvault.vault.azure.net" });
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
  });

  test("reads values with versions", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const read = await provider.readSecret("secret/db-password");
    expect(read.value).toBe("s3cret");
    expect(read.metadata?.version).toBe("v1");
  });

  test("a missing secret is a 404", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    const error = await provider.readSecret("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("writes set values", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.writeSecret("secret/new", "fresh");
    expect(secrets["new"]?.value).toBe("fresh");
  });

  test("deletes purge after soft-delete", async () => {
    const provider = new AzureKeyVaultProvider(connection);
    await provider.deleteSecret("secret/db-password");
    expect(purged).toEqual(["db-password"]);
    expect(secrets["db-password"].deleted).toBe(true);

    const error = await provider.deleteSecret("secret/db-password").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("capabilities declare the vault surface", () => {
    const provider = new AzureKeyVaultProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "vault", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toEqual(["tree", "secret.read", "secret.write", "secret.delete"]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Vault", itemNoun: "Secrets" });
  });
});
