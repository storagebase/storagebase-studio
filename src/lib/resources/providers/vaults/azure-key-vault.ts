import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNode,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type { SecretRead, VaultOperations } from "../../operations";

/**
 * The Azure Key Vault provider (secrets). Authenticates with Microsoft Entra
 * ID (`ClientSecretCredential` matches the connection fields) against the
 * vault URL — the `endpoint` spelled out or built from `vaultName`.
 *
 * Key Vault has no mounts and no folders: secrets are one flat namespace, so
 * the tree roots ARE the secrets and `listSecrets` ignores its mount. Delete
 * is the full two-step (begin + purge): soft-delete alone would leave the
 * secret recoverable while the viewer reported it gone — a quieter lie than
 * D31 only in volume.
 */

type SecretsModule = typeof import("@azure/keyvault-secrets");
type IdentityModule = typeof import("@azure/identity");

let secretsModule: SecretsModule | null = null;
let identityModule: IdentityModule | null = null;

async function loadSecrets(): Promise<SecretsModule> {
  if (secretsModule) return secretsModule;
  try {
    secretsModule = await import("@azure/keyvault-secrets");
    return secretsModule;
  } catch {
    throw new ResourceConfigError(
      "Azure SDK (@azure/keyvault-secrets) is not available in this environment. Install it with: bun add @azure/keyvault-secrets",
    );
  }
}

async function loadIdentity(): Promise<IdentityModule> {
  if (identityModule) return identityModule;
  try {
    identityModule = await import("@azure/identity");
    return identityModule;
  } catch {
    throw new ResourceConfigError(
      "Azure SDK (@azure/identity) is not available in this environment. Install it with: bun add @azure/identity",
    );
  }
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Key Vault ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const status =
    (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "SecretNotFound";
}

export class AzureKeyVaultProvider extends BaseResourceProvider implements VaultOperations {
  private client: InstanceType<SecretsModule["SecretClient"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.endpoint && !this.config.vaultName) {
      throw new ResourceConfigError('A Key Vault connection requires a vault "endpoint" or a "vaultName"');
    }
    if (!this.config.tenantId || !this.config.clientId || !this.config.clientSecret) {
      throw new ResourceConfigError(
        "A Key Vault connection requires Entra ID credentials (tenantId, clientId, clientSecret)",
      );
    }
  }

  private vaultUrl(): string {
    if (this.config.endpoint) return this.config.endpoint.replace(/\/$/, "");
    return `https://${this.config.vaultName as string}.vault.azure.net`;
  }

  private async getClient(): Promise<InstanceType<SecretsModule["SecretClient"]>> {
    if (this.client) return this.client;
    const [secrets, identity] = await Promise.all([loadSecrets(), loadIdentity()]);
    const credential = new identity.ClientSecretCredential(
      this.config.tenantId as string,
      this.config.clientId as string,
      this.config.clientSecret as string,
    );
    this.client = new secrets.SecretClient(this.vaultUrl(), credential);
    return this.client;
  }

  public async connect(): Promise<void> {
    try {
      await this.listMounts();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    this.client = null;
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    await this.listMounts();
    return { status: "healthy", latencyMs: Date.now() - start };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "vault",
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "secret.read", "secret.write", "secret.delete"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Vault", itemNoun: "Secrets" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId !== null) return { nodes: [], truncated: false };
    return this.listMounts();
  }

  public async listMounts(): Promise<ResourceNodePage> {
    // No mounts exist: every secret is a root, addressed by name alone.
    return this.listSecrets("", null);
  }

  public async listSecrets(_mount: string, prefix: string | null): Promise<ResourceNodePage> {
    try {
      const client = await this.getClient();
      const nodes: ResourceNode[] = [];
      for await (const properties of client.listPropertiesOfSecrets()) {
        if (prefix !== null && !properties.name.startsWith(prefix)) continue;
        nodes.push({
          id: `secret/${properties.name}`,
          parentId: null,
          kind: "secret",
          name: properties.name,
          meta: {
            ...(properties.enabled !== undefined ? { enabled: properties.enabled } : {}),
            ...(properties.updatedOn ? { modified: properties.updatedOn.toISOString() } : {}),
          },
          hasChildren: false,
        });
      }
      return { nodes, truncated: false };
    } catch (error) {
      throw toConnectionError(error, "list secrets");
    }
  }

  public async readSecret(path: string): Promise<SecretRead> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const secret = await client.getSecret(name);
      return {
        name: path,
        value: secret.value ?? "",
        metadata: {
          version: secret.properties.version ?? null,
          createdAt: secret.properties.createdOn?.toISOString() ?? null,
        },
      };
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
      throw toConnectionError(error, `read "${path}"`);
    }
  }

  public async writeSecret(path: string, value: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      await client.setSecret(name, value);
    } catch (error) {
      throw toConnectionError(error, `write "${path}"`);
    }
  }

  public async deleteSecret(path: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const poller = await client.beginDeleteSecret(name);
      await poller.pollUntilDone();
      // Soft-delete alone leaves the secret recoverable while the viewer
      // reports it gone: purge completes the delete the tree just promised.
      await client.purgeDeletedSecret(name);
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
      throw toConnectionError(error, `delete "${path}"`);
    }
  }
}

/**
 * Split a secret address back to its bare name. Ids are `secret/<name>` with
 * no mounts; a bare name passes through for publish-style callers.
 */
function splitSecretPath(path: string): string {
  return path.startsWith("secret/") ? path.slice("secret/".length) : path;
}

registerResourceProviderLoader("azure-key-vault", () =>
  import("./azure-key-vault").then((m) => ({ default: m.AzureKeyVaultProvider })),
);
