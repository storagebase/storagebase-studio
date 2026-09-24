import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import {
  ResourceConfigError,
  ResourceConflictError,
  ResourceConnectionError,
  ResourceError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
} from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNode,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type {
  SecretRead,
  VaultCertificateImport,
  VaultDeletedObject,
  VaultKeyCreate,
  VaultObjectDetail,
  VaultObjectListing,
  VaultObjectSummary,
  VaultObjectType,
  VaultObjectVersion,
  VaultOperations,
  VaultSecretReveal,
  VaultSecretWrite,
  VaultWorkbenchOperations,
} from "../../operations";

/**
 * The Azure Key Vault provider (secrets). Authenticates with Microsoft Entra
 * ID (`ClientSecretCredential` matches the connection fields) against the
 * vault URL — the `endpoint` spelled out or built from `vaultName`.
 *
 * Key Vault has no mounts and no folders: secrets are one flat namespace, so
 * the tree roots ARE the secrets and `listSecrets` ignores its mount.
 *
 * Delete is SOFT (begin + poll), on both surfaces. It used to purge right
 * after, which destroyed recoverable data on a click and failed outright on
 * purge-protected vaults — after the soft delete had already happened, so
 * the caller saw an error for a delete that had in fact landed. Purge is now
 * its own, separately confirmed operation on the deleted-items view.
 *
 * The workbench surface (`VaultWorkbenchOperations`) covers secrets, keys and
 * certificates. Secret values are read in exactly one place, `revealSecret`
 * (and the legacy `readSecret`): listings and details are built from
 * properties and version lists, so opening a secret never reads its value.
 */

import { loadResourceSdk } from "../../sdk-loader";

type SecretsModule = typeof import("@azure/keyvault-secrets");
type KeysModule = typeof import("@azure/keyvault-keys");
type CertificatesModule = typeof import("@azure/keyvault-certificates");
type IdentityModule = typeof import("@azure/identity");

function loadSecrets(): Promise<SecretsModule> {
  return loadResourceSdk<SecretsModule>(
    "@azure/keyvault-secrets",
    "Azure SDK (@azure/keyvault-secrets)",
    "bun add @azure/keyvault-secrets",
  );
}

function loadKeys(): Promise<KeysModule> {
  return loadResourceSdk<KeysModule>(
    "@azure/keyvault-keys",
    "Azure SDK (@azure/keyvault-keys)",
    "bun add @azure/keyvault-keys",
  );
}

function loadCertificates(): Promise<CertificatesModule> {
  return loadResourceSdk<CertificatesModule>(
    "@azure/keyvault-certificates",
    "Azure SDK (@azure/keyvault-certificates)",
    "bun add @azure/keyvault-certificates",
  );
}

function loadIdentity(): Promise<IdentityModule> {
  return loadResourceSdk<IdentityModule>("@azure/identity", "Azure SDK (@azure/identity)", "bun add @azure/identity");
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Key Vault ${what} failed: ${message}`);
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return (
    statusOf(error) === 404 ||
    code === "SecretNotFound" ||
    code === "KeyNotFound" ||
    code === "CertificateNotFound" ||
    code === "NotFound"
  );
}

/** The workbench's error vocabulary: 404, 409 (being deleted, purge protection), 400, else 502. */
function translateVaultError(error: unknown, what: string): ResourceError {
  if (error instanceof ResourceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (isMissing(error)) return new ResourceNotFoundError(`Key Vault ${what}: ${message}`);
  if (statusOf(error) === 409) return new ResourceConflictError(`Key Vault ${what}: ${message}`);
  if (statusOf(error) === 400) return new ResourceInvalidRequestError(`Key Vault ${what}: ${message}`);
  return toConnectionError(error, what);
}

/** Objects a listing reads before answering `truncated`. */
export const KEY_VAULT_LIST_LIMIT = 1000;

/** Versions a detail lists before answering `versionsTruncated`. */
export const KEY_VAULT_VERSION_LIMIT = 100;

/**
 * Keys and certificates whose listing row is enriched with a per-object read
 * (key type and size; certificate subject and issuer): the list API carries
 * neither. Best effort, a few in flight; past the bound the fields are null.
 */
export const KEY_VAULT_ENRICH_LIMIT = 100;

const ENRICH_CONCURRENCY = 4;

function iso(date: Date | undefined | null): string | null {
  return date ? date.toISOString() : null;
}

function tagsOf(tags: Record<string, string> | undefined): Record<string, string> {
  return { ...tags };
}

function blankSummary(type: VaultObjectType, name: string): VaultObjectSummary {
  return {
    type,
    name,
    enabled: null,
    createdOn: null,
    updatedOn: null,
    expiresOn: null,
    notBefore: null,
    tags: {},
    contentType: null,
    keyType: null,
    keySize: null,
    curve: null,
    subject: null,
    issuer: null,
    thumbprint: null,
  };
}

interface CommonProperties {
  enabled?: boolean;
  createdOn?: Date;
  updatedOn?: Date;
  expiresOn?: Date;
  notBefore?: Date;
  tags?: Record<string, string>;
  version?: string;
  recoveryLevel?: string;
}

function commonFields(properties: CommonProperties) {
  return {
    enabled: properties.enabled ?? null,
    createdOn: iso(properties.createdOn),
    updatedOn: iso(properties.updatedOn),
    expiresOn: iso(properties.expiresOn),
    notBefore: iso(properties.notBefore),
    tags: tagsOf(properties.tags),
  };
}

function versionOf(properties: CommonProperties): VaultObjectVersion {
  return {
    version: properties.version ?? "",
    enabled: properties.enabled ?? null,
    createdOn: iso(properties.createdOn),
    updatedOn: iso(properties.updatedOn),
    expiresOn: iso(properties.expiresOn),
  };
}

/** Key type and size from the public JWK: RSA size is the modulus length; EC names its curve. */
function keyShape(key: { keyType?: string; key?: { n?: Uint8Array; crv?: string } }) {
  const keyType = key.keyType ?? null;
  return {
    keyType,
    keySize: key.key?.n ? key.key.n.length * 8 : null,
    curve: key.key?.crv ?? null,
  };
}

function thumbprintOf(bytes: Uint8Array | undefined): string | null {
  return bytes ? Buffer.from(bytes).toString("hex").toUpperCase() : null;
}

async function collect<T>(iterable: AsyncIterable<T>, limit: number): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for await (const item of iterable) {
    if (items.length === limit) return { items, truncated: true };
    items.push(item);
  }
  return { items, truncated: false };
}

async function mapBounded<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(ENRICH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Newest first: Key Vault's current version is the most recently created one. */
function byCreatedDesc(a: CommonProperties, b: CommonProperties): number {
  return (b.createdOn?.getTime() ?? 0) - (a.createdOn?.getTime() ?? 0);
}

export class AzureKeyVaultProvider extends BaseResourceProvider implements VaultOperations, VaultWorkbenchOperations {
  private client: InstanceType<SecretsModule["SecretClient"]> | null = null;
  private keyClient: InstanceType<KeysModule["KeyClient"]> | null = null;
  private certificateClient: InstanceType<CertificatesModule["CertificateClient"]> | null = null;

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

  private async credential() {
    const identity = await loadIdentity();
    return new identity.ClientSecretCredential(
      this.config.tenantId as string,
      this.config.clientId as string,
      this.config.clientSecret as string,
    );
  }

  private async getClient(): Promise<InstanceType<SecretsModule["SecretClient"]>> {
    if (this.client) return this.client;
    const [secrets, credential] = await Promise.all([loadSecrets(), this.credential()]);
    this.client = new secrets.SecretClient(this.vaultUrl(), credential);
    return this.client;
  }

  private async getKeyClient(): Promise<InstanceType<KeysModule["KeyClient"]>> {
    if (this.keyClient) return this.keyClient;
    const [keys, credential] = await Promise.all([loadKeys(), this.credential()]);
    this.keyClient = new keys.KeyClient(this.vaultUrl(), credential);
    return this.keyClient;
  }

  private async getCertificateClient(): Promise<InstanceType<CertificatesModule["CertificateClient"]>> {
    if (this.certificateClient) return this.certificateClient;
    const [certificates, credential] = await Promise.all([loadCertificates(), this.credential()]);
    this.certificateClient = new certificates.CertificateClient(this.vaultUrl(), credential);
    return this.certificateClient;
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
    this.keyClient = null;
    this.certificateClient = null;
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
      operations: [
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
      ],
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
      // Soft delete only: recover and purge are the deleted-items view's.
      const poller = await client.beginDeleteSecret(name);
      await poller.pollUntilDone();
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
      throw toConnectionError(error, `delete "${path}"`);
    }
  }

  // --- Vault workbench (VaultWorkbenchOperations) ---

  public async listVaultObjects(type: VaultObjectType): Promise<VaultObjectListing> {
    try {
      if (type === "secret") {
        const client = await this.getClient();
        const { items, truncated } = await collect(client.listPropertiesOfSecrets(), KEY_VAULT_LIST_LIMIT);
        return {
          objects: items.map((properties) => ({
            ...blankSummary("secret", properties.name),
            ...commonFields(properties),
            contentType: properties.contentType ?? null,
          })),
          truncated,
        };
      }
      if (type === "key") {
        const client = await this.getKeyClient();
        const { items, truncated } = await collect(client.listPropertiesOfKeys(), KEY_VAULT_LIST_LIMIT);
        // The key list carries no key type or size: the first N rows are
        // enriched by a per-key read, each one best effort.
        const shapes = await mapBounded(items.slice(0, KEY_VAULT_ENRICH_LIMIT), async (properties) =>
          keyShape(await client.getKey(properties.name).catch(() => ({}))),
        );
        return {
          objects: items.map((properties, index) => ({
            ...blankSummary("key", properties.name),
            ...commonFields(properties),
            ...shapes[index],
          })),
          truncated,
        };
      }
      const client = await this.getCertificateClient();
      const { items, truncated } = await collect(client.listPropertiesOfCertificates(), KEY_VAULT_LIST_LIMIT);
      const policies = await mapBounded(items.slice(0, KEY_VAULT_ENRICH_LIMIT), (properties) =>
        client.getCertificatePolicy(properties.name as string).catch(() => undefined),
      );
      return {
        objects: items.map((properties, index) => ({
          ...blankSummary("certificate", properties.name as string),
          ...commonFields(properties),
          subject: policies[index]?.subject ?? null,
          issuer: policies[index]?.issuerName ?? null,
          thumbprint: thumbprintOf(properties.x509Thumbprint),
        })),
        truncated,
      };
    } catch (error) {
      throw translateVaultError(error, `list ${type}s`);
    }
  }

  public async describeVaultObject(type: VaultObjectType, name: string): Promise<VaultObjectDetail> {
    try {
      if (type === "secret") {
        // Built from the version list, NOT getSecret: opening a secret must
        // never read its value (it would also land in the vault's own access
        // log as a secret get). The current version is the newest one.
        const client = await this.getClient();
        const { items, truncated } = await collect(
          client.listPropertiesOfSecretVersions(name),
          KEY_VAULT_VERSION_LIMIT,
        );
        const versions = [...items].sort(byCreatedDesc);
        const current = versions[0];
        if (current === undefined) throw new ResourceNotFoundError(`Secret "${name}" does not exist`);
        return {
          ...blankSummary("secret", name),
          ...commonFields(current),
          contentType: current.contentType ?? null,
          version: current.version ?? null,
          recoveryLevel: current.recoveryLevel ?? null,
          keyOperations: [],
          versions: versions.map(versionOf),
          versionsTruncated: truncated,
        };
      }
      if (type === "key") {
        const client = await this.getKeyClient();
        const key = await client.getKey(name);
        const { items, truncated } = await collect(client.listPropertiesOfKeyVersions(name), KEY_VAULT_VERSION_LIMIT);
        return {
          ...blankSummary("key", name),
          ...commonFields(key.properties),
          ...keyShape(key),
          version: key.properties.version ?? null,
          recoveryLevel: key.properties.recoveryLevel ?? null,
          keyOperations: key.keyOperations ?? [],
          versions: [...items].sort(byCreatedDesc).map(versionOf),
          versionsTruncated: truncated,
        };
      }
      const client = await this.getCertificateClient();
      const certificate = await client.getCertificate(name);
      const { items, truncated } = await collect(
        client.listPropertiesOfCertificateVersions(name),
        KEY_VAULT_VERSION_LIMIT,
      );
      return {
        ...blankSummary("certificate", name),
        ...commonFields(certificate.properties),
        subject: certificate.policy?.subject ?? null,
        issuer: certificate.policy?.issuerName ?? null,
        thumbprint: thumbprintOf(certificate.properties.x509Thumbprint),
        version: certificate.properties.version ?? null,
        recoveryLevel: certificate.properties.recoveryLevel ?? null,
        keyOperations: [],
        versions: [...items].sort(byCreatedDesc).map(versionOf),
        versionsTruncated: truncated,
      };
    } catch (error) {
      throw translateVaultError(error, `describe ${type} "${name}"`);
    }
  }

  public async revealSecret(name: string, version?: string): Promise<VaultSecretReveal> {
    try {
      const client = await this.getClient();
      const secret = await client.getSecret(name, version === undefined ? {} : { version });
      return { name, value: secret.value ?? "", version: secret.properties.version ?? null };
    } catch (error) {
      throw translateVaultError(error, `reveal "${name}"`);
    }
  }

  public async saveSecret(name: string, input: VaultSecretWrite): Promise<void> {
    const properties = {
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      ...(input.tags === undefined ? {} : { tags: { ...input.tags } }),
      ...(input.expiresOn ? { expiresOn: new Date(input.expiresOn) } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
    try {
      const client = await this.getClient();
      if (input.value !== undefined) {
        // A new value is a new version, carrying the properties with it.
        await client.setSecret(name, input.value, properties);
        return;
      }
      // Properties only: the current version is updated in place and its
      // value is never read or re-sent.
      const { items } = await collect(client.listPropertiesOfSecretVersions(name), KEY_VAULT_VERSION_LIMIT);
      const current = [...items].sort(byCreatedDesc)[0];
      if (current?.version === undefined) throw new ResourceNotFoundError(`Secret "${name}" does not exist`);
      await client.updateSecretProperties(name, current.version, properties);
    } catch (error) {
      throw translateVaultError(error, `save "${name}"`);
    }
  }

  public async createKey(name: string, input: VaultKeyCreate): Promise<void> {
    const common = {
      ...(input.tags === undefined ? {} : { tags: { ...input.tags } }),
      ...(input.expiresOn === undefined ? {} : { expiresOn: new Date(input.expiresOn) }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
    try {
      const client = await this.getKeyClient();
      if (input.keyType === "RSA") await client.createRsaKey(name, { ...common, keySize: input.keySize });
      else await client.createEcKey(name, { ...common, curve: input.curve });
    } catch (error) {
      throw translateVaultError(error, `create key "${name}"`);
    }
  }

  public async importCertificate(name: string, input: VaultCertificateImport): Promise<void> {
    try {
      const client = await this.getCertificateClient();
      await client.importCertificate(name, Buffer.from(input.contentsBase64, "base64"), {
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.tags === undefined ? {} : { tags: { ...input.tags } }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        policy: { contentType: input.format === "pem" ? "application/x-pem-file" : "application/x-pkcs12" },
      });
    } catch (error) {
      throw translateVaultError(error, `import certificate "${name}"`);
    }
  }

  public async deleteVaultObject(type: VaultObjectType, name: string): Promise<void> {
    try {
      if (type === "secret") await (await (await this.getClient()).beginDeleteSecret(name)).pollUntilDone();
      else if (type === "key") await (await (await this.getKeyClient()).beginDeleteKey(name)).pollUntilDone();
      else await (await (await this.getCertificateClient()).beginDeleteCertificate(name)).pollUntilDone();
    } catch (error) {
      throw translateVaultError(error, `delete ${type} "${name}"`);
    }
  }

  public async listDeletedVaultObjects(type: VaultObjectType): Promise<readonly VaultDeletedObject[]> {
    try {
      if (type === "secret") {
        const { items } = await collect((await this.getClient()).listDeletedSecrets(), KEY_VAULT_LIST_LIMIT);
        return items.map((deleted) => ({
          type,
          name: deleted.properties.name,
          deletedOn: iso(deleted.properties.deletedOn),
          scheduledPurgeDate: iso(deleted.properties.scheduledPurgeDate),
        }));
      }
      if (type === "key") {
        const { items } = await collect((await this.getKeyClient()).listDeletedKeys(), KEY_VAULT_LIST_LIMIT);
        return items.map((deleted) => ({
          type,
          name: deleted.name,
          deletedOn: iso(deleted.properties.deletedOn),
          scheduledPurgeDate: iso(deleted.properties.scheduledPurgeDate),
        }));
      }
      const { items } = await collect(
        (await this.getCertificateClient()).listDeletedCertificates(),
        KEY_VAULT_LIST_LIMIT,
      );
      return items.map((deleted) => ({
        type,
        name: deleted.name,
        deletedOn: iso(deleted.deletedOn),
        scheduledPurgeDate: iso(deleted.scheduledPurgeDate),
      }));
    } catch (error) {
      throw translateVaultError(error, `list deleted ${type}s`);
    }
  }

  public async recoverDeletedVaultObject(type: VaultObjectType, name: string): Promise<void> {
    try {
      if (type === "secret") await (await (await this.getClient()).beginRecoverDeletedSecret(name)).pollUntilDone();
      else if (type === "key") await (await (await this.getKeyClient()).beginRecoverDeletedKey(name)).pollUntilDone();
      else {
        await (await (await this.getCertificateClient()).beginRecoverDeletedCertificate(name)).pollUntilDone();
      }
    } catch (error) {
      throw translateVaultError(error, `recover ${type} "${name}"`);
    }
  }

  public async purgeDeletedVaultObject(type: VaultObjectType, name: string): Promise<void> {
    try {
      if (type === "secret") await (await this.getClient()).purgeDeletedSecret(name);
      else if (type === "key") await (await this.getKeyClient()).purgeDeletedKey(name);
      else await (await this.getCertificateClient()).purgeDeletedCertificate(name);
    } catch (error) {
      throw translateVaultError(error, `purge ${type} "${name}"`);
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
