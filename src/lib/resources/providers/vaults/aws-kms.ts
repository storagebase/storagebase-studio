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
 * The AWS KMS provider — the deliberate misfit of the vault family, mapped
 * rather than refused. KMS manages keys, not secrets: key material can never
 * be read by design, so every mapping below is documented instead of argued:
 *
 * - listSecrets lists KEYS (kind "key", addressed by key id or alias).
 * - readSecret answers `describeKey` as JSON: the value is key METADATA
 *   (state, creation, rotation), because the material itself is unreadable.
 * - writeSecret creates a key: `value` becomes the description, and a `path`
 *   of `alias/<name>` additionally names an alias for it. Creation never
 *   updates — a KMS key is immutable after birth, so "write" on an existing
 *   id is refused rather than reinterpreted.
 * - deleteSecret schedules deletion with the minimum 7-day window
 *   (`PendingWindowInDays: 7`): the only deletion KMS offers, and the viewer
 *   names the window in its confirm so the click promises exactly this.
 */

import { loadResourceSdk } from "../../sdk-loader";

type KmsModule = typeof import("@aws-sdk/client-kms");

function loadKms(): Promise<KmsModule> {
  return loadResourceSdk<KmsModule>(
    "@aws-sdk/client-kms",
    "AWS SDK (@aws-sdk/client-kms)",
    "bun add @aws-sdk/client-kms",
  );
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`KMS ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "NotFoundException";
}

export class AwsKmsProvider extends BaseResourceProvider implements VaultOperations {
  private client: InstanceType<KmsModule["KMSClient"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.region) {
      throw new ResourceConfigError('A KMS connection requires a "region"');
    }
  }

  private async getClient(): Promise<InstanceType<KmsModule["KMSClient"]>> {
    if (this.client) return this.client;
    const sdk = await loadKms();
    this.client = new sdk.KMSClient({
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
      operations: ["tree", "secret.read", "secret.write", "secret.delete", "vault.keys", "vault.delete"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Keys", itemNoun: "Keys" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId !== null) return { nodes: [], truncated: false };
    return this.listMounts();
  }

  public async listMounts(): Promise<ResourceNodePage> {
    // No mounts exist: every key is a root, addressed by id or alias.
    return this.listSecrets("", null);
  }

  public async listSecrets(_mount: string, prefix: string | null): Promise<ResourceNodePage> {
    try {
      const client = await this.getClient();
      const sdk = await loadKms();
      const response = await client.send(new sdk.ListKeysCommand({ Limit: 100 }));
      const keys = response.Keys ?? [];
      const filtered = prefix === null ? keys : keys.filter((key) => (key.KeyId ?? "").startsWith(prefix));
      return {
        nodes: filtered
          .filter((key) => key.KeyId !== undefined)
          .map((key) => ({
            id: `key/${key.KeyId as string}`,
            parentId: null,
            kind: "key",
            name: key.KeyId as string,
            hasChildren: false,
          })),
        truncated: response.Truncated === true || response.NextMarker !== undefined,
      };
    } catch (error) {
      throw toConnectionError(error, "list keys");
    }
  }

  public async readSecret(path: string): Promise<SecretRead> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadKms();
      const response = await client.send(new sdk.DescribeKeyCommand({ KeyId: name }));
      const metadata = response.KeyMetadata;
      if (!metadata) throw new ResourceNotFoundError(`Key "${path}" does not exist`);
      return {
        name: path,
        value: JSON.stringify(metadata, null, 2),
        metadata: {
          version: null,
          createdAt:
            metadata.CreationDate instanceof Date
              ? metadata.CreationDate.toISOString()
              : (metadata.CreationDate as number | undefined) !== undefined
                ? new Date(Number(metadata.CreationDate) * 1000).toISOString()
                : null,
        },
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Key "${path}" does not exist`);
      throw toConnectionError(error, `describe "${path}"`);
    }
  }

  public async writeSecret(path: string, value: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadKms();
      // Keys are immutable after birth: creation is the only write, and the
      // description carries the caller's text. An `alias/<name>` path names
      // an alias for the new key in the same call.
      const created = await client.send(
        new sdk.CreateKeyCommand({ Description: value || `Created by StorageBase Studio` }),
      );
      const keyId = created.KeyMetadata?.KeyId;
      if (!keyId) throw toConnectionError(new Error("createKey answered no key id"), `create key "${path}"`);
      if (name.startsWith("alias/")) {
        try {
          await client.send(new sdk.CreateAliasCommand({ AliasName: name, TargetKeyId: keyId }));
        } catch (error) {
          // Keys are immutable but aliases are pointers: re-writing an alias
          // rotates it onto the new key (measured against LocalStack). A
          // second caller racing the same alias may still collide — the
          // service's sentence, surfaced as-is, says so.
          if ((error as { name?: string })?.name !== "AlreadyExistsException") throw error;
          await client.send(new sdk.UpdateAliasCommand({ AliasName: name, TargetKeyId: keyId }));
        }
      }
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, `create key "${path}"`);
    }
  }

  public async deleteSecret(path: string): Promise<void> {
    const name = splitSecretPath(path);
    try {
      const client = await this.getClient();
      const sdk = await loadKms();
      // The minimum window, named in the viewer's confirm: KMS offers no
      // immediate delete, only scheduled oblivion 7+ days out.
      await client.send(new sdk.ScheduleKeyDeletionCommand({ KeyId: name, PendingWindowInDays: 7 }));
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Key "${path}" does not exist`);
      throw toConnectionError(error, `schedule deletion of "${path}"`);
    }
  }
}

/**
 * Split a key address back to its bare id. Ids are `key/<id-or-alias>` with
 * no mounts; a bare id or alias ARN passes through for publish-style callers.
 */
function splitSecretPath(path: string): string {
  return path.startsWith("key/") ? path.slice("key/".length) : path;
}

registerResourceProviderLoader("aws-kms", () => import("./aws-kms").then((m) => ({ default: m.AwsKmsProvider })));
