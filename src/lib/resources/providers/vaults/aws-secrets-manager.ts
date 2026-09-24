import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type { SecretRead, VaultOperations } from "../../operations";

/**
 * The AWS Secrets Manager provider. The natural fit for the secret surface:
 * flat secret names, string values, real create/update/delete.
 *
 * Mappings, each documented because the API is not quite the interface:
 * - listSecrets pages at 100 with the service's NextToken as the truncation
 *   verdict (one page plus a peek would double every listing for nothing —
 *   the token's presence IS the measurement).
 * - writeSecret tries create, then put on ResourceExists: "write" means
 *   upsert here, and the two calls are the only way to spell it.
 * - deleteSecret uses the DEFAULT recovery window (no force): the secret
 *   becomes unrecoverable after 30 days, not today. Forcing would make the
 *   viewer's confirm button promise less than the API delivers in reverse —
 *   an irreversible click with a reversible sentence.
 * - Binary secrets have no text to show: the read names the encoding and
 *   refuses the value rather than base64-ing bytes into a text pane.
 */

import { loadResourceSdk } from "../../sdk-loader";

type SecretsManagerModule = typeof import("@aws-sdk/client-secrets-manager");

function loadSecretsManager(): Promise<SecretsManagerModule> {
  return loadResourceSdk<SecretsManagerModule>(
    "@aws-sdk/client-secrets-manager",
    "AWS SDK (@aws-sdk/client-secrets-manager)",
    "bun add @aws-sdk/client-secrets-manager",
  );
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Secrets Manager ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "ResourceNotFoundException";
}

export class AwsSecretsManagerProvider extends BaseResourceProvider implements VaultOperations {
  private client: InstanceType<SecretsManagerModule["SecretsManagerClient"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.region) {
      throw new ResourceConfigError('A Secrets Manager connection requires a "region"');
    }
  }

  private async getClient(): Promise<InstanceType<SecretsManagerModule["SecretsManagerClient"]>> {
    if (this.client) return this.client;
    const sdk = await loadSecretsManager();
    this.client = new sdk.SecretsManagerClient({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      ...(this.config.accessKeyId
        ? {
            credentials: {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey ?? "",
              ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
            },
          }
        : {}),
    });
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
    this.client?.destroy();
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
      // The workbench flags (basic-workbench.ts serves them): no soft
      // delete, no secret properties, no certificates on this service.
      operations: [
        "tree",
        "secret.read",
        "secret.write",
        "secret.delete",
        "vault.secrets",
        "vault.secret.reveal",
        "vault.secret.write",
        "vault.delete",
      ],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Secrets", itemNoun: "Secrets" };
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
      const sdk = await loadSecretsManager();
      const response = await client.send(
        new sdk.ListSecretsCommand({
          MaxResults: 100,
          ...(prefix ? { Filters: [{ Key: "name", Values: [prefix] }] } : {}),
        }),
      );
      return {
        nodes: (response.SecretList ?? [])
          .filter((secret) => secret.Name !== undefined)
          .map((secret) => ({
            id: `secret/${secret.Name as string}`,
            parentId: null,
            kind: "secret",
            name: secret.Name as string,
            meta: {
              ...(secret.LastChangedDate ? { modified: secret.LastChangedDate.toISOString() } : {}),
            },
            hasChildren: false,
          })),
        truncated: response.NextToken !== undefined,
      };
    } catch (error) {
      throw toConnectionError(error, "list secrets");
    }
  }

  public async readSecret(path: string): Promise<SecretRead> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadSecretsManager();
      const response = await client.send(new sdk.GetSecretValueCommand({ SecretId: name }));
      if (response.SecretString !== undefined) {
        return {
          name: path,
          value: response.SecretString,
          metadata: { version: response.VersionId ?? null, createdAt: response.CreatedDate?.toISOString() ?? null },
        };
      }
      throw new ResourceConfigError(
        `Secret "${path}" holds binary data, which has no text to show: use the AWS console to inspect it`,
      );
    } catch (error) {
      if (error instanceof ResourceConfigError) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
      throw toConnectionError(error, `read "${path}"`);
    }
  }

  public async writeSecret(path: string, value: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadSecretsManager();
      try {
        await client.send(new sdk.CreateSecretCommand({ Name: name, SecretString: value }));
      } catch (error) {
        if ((error as { name?: string })?.name !== "ResourceExistsException") throw error;
        await client.send(new sdk.UpdateSecretCommand({ SecretId: name, SecretString: value }));
      }
    } catch (error) {
      throw toConnectionError(error, `write "${path}"`);
    }
  }

  public async deleteSecret(path: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadSecretsManager();
      // Default recovery window, not ForceDeleteWithoutRecovery: the viewer's
      // confirm promises a deletion, and a 30-day recovery beats an
      // irreversible click with no undo.
      await client.send(new sdk.DeleteSecretCommand({ SecretId: name }));
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

registerResourceProviderLoader("aws-secrets-manager", () =>
  import("./aws-secrets-manager").then((m) => ({ default: m.AwsSecretsManagerProvider })),
);
