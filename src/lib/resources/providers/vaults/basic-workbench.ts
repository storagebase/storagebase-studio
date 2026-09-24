import { ResourceNotFoundError, ResourceOperationUnsupportedError } from "../../errors";
import type { ResourceNode, ResourceNodePage } from "../../types";
import type {
  VaultDeletedObject,
  VaultObjectDetail,
  VaultObjectListing,
  VaultObjectSummary,
  VaultObjectType,
  VaultOperations,
  VaultSecretReveal,
  VaultSecretWrite,
  VaultWorkbenchOperations,
} from "../../operations";

/**
 * The vault workbench over a provider that only speaks the generic
 * `VaultOperations` (HashiCorp Vault / OpenBao, AWS Secrets Manager, AWS
 * KMS). What those services cannot do the provider simply does not declare
 * (`vault.soft-delete`, `vault.secret.metadata`, key creation, certificates),
 * so the workbench never renders the control and the calls below that have
 * no meaning refuse with the honest sentence.
 *
 * Listings flatten the provider's tree (Vault's mounts and folders) into one
 * list of paths, bounded; the path IS the object name every by-name call
 * takes. Details come from the listing, never from `readSecret`: opening an
 * object must not read its value.
 */

/** Objects one flattened listing collects before answering `truncated`. */
export const BASIC_VAULT_LIST_LIMIT = 1000;

/** Tree levels one flattened listing reads (mounts, folders) before stopping. */
export const BASIC_VAULT_LEVEL_LIMIT = 200;

/** The by-name address a tree leaf answers to: its id without the scheme prefix. */
export function vaultPathOf(node: ResourceNode): string {
  return node.id.replace(/^(mount|secret|key)\//, "");
}

/** Which workbench tab a tree leaf belongs to. KMS leaves are keys; everything else is a secret. */
export function vaultTypeOf(node: ResourceNode): VaultObjectType {
  return node.kind === "key" ? "key" : "secret";
}

function summaryOf(node: ResourceNode): VaultObjectSummary {
  const meta = node.meta ?? {};
  return {
    type: vaultTypeOf(node),
    name: vaultPathOf(node),
    enabled: typeof meta.enabled === "boolean" ? meta.enabled : null,
    createdOn: null,
    updatedOn: typeof meta.modified === "string" ? meta.modified : null,
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

type TreeProvider = VaultOperations & { listNodes(parentId: string | null): Promise<ResourceNodePage> };

export class BasicVaultWorkbench implements VaultWorkbenchOperations {
  constructor(private readonly provider: TreeProvider) {}

  public async listVaultObjects(type: VaultObjectType): Promise<VaultObjectListing> {
    const objects: VaultObjectSummary[] = [];
    let truncated = false;
    let levels = 0;
    const queue: Array<string | null> = [null];
    while (queue.length > 0) {
      if (levels === BASIC_VAULT_LEVEL_LIMIT) {
        truncated = true;
        break;
      }
      levels += 1;
      const page = await this.provider.listNodes(queue.shift() as string | null);
      truncated ||= page.truncated;
      for (const node of page.nodes) {
        if (node.hasChildren) queue.push(node.id);
        else if (vaultTypeOf(node) === type) objects.push(summaryOf(node));
      }
      if (objects.length >= BASIC_VAULT_LIST_LIMIT) {
        truncated = true;
        break;
      }
    }
    return { objects: objects.slice(0, BASIC_VAULT_LIST_LIMIT), truncated };
  }

  public async describeVaultObject(type: VaultObjectType, name: string): Promise<VaultObjectDetail> {
    const { objects } = await this.listVaultObjects(type);
    const found = objects.find((object) => object.name === name);
    if (found === undefined) throw new ResourceNotFoundError(`${type} "${name}" does not exist`);
    return { ...found, version: null, recoveryLevel: null, keyOperations: [], versions: [], versionsTruncated: false };
  }

  public async revealSecret(name: string): Promise<VaultSecretReveal> {
    const read = await this.provider.readSecret(name);
    return { name, value: read.value, version: read.metadata?.version ?? null };
  }

  public async saveSecret(name: string, input: VaultSecretWrite): Promise<void> {
    // No properties to update on these services: a save is a new value.
    if (input.value === undefined) {
      throw new ResourceOperationUnsupportedError("This vault has no secret properties to update; enter a value");
    }
    await this.provider.writeSecret(name, input.value);
  }

  public async createKey(): Promise<void> {
    throw new ResourceOperationUnsupportedError("This vault does not create keys from the workbench");
  }

  public async importCertificate(): Promise<void> {
    throw new ResourceOperationUnsupportedError("This vault holds no certificates");
  }

  public async deleteVaultObject(_type: VaultObjectType, name: string): Promise<void> {
    await this.provider.deleteSecret(name);
  }

  public async listDeletedVaultObjects(): Promise<readonly VaultDeletedObject[]> {
    throw new ResourceOperationUnsupportedError("This vault has no deleted-items view");
  }

  public async recoverDeletedVaultObject(): Promise<void> {
    throw new ResourceOperationUnsupportedError("This vault has no deleted-items view");
  }

  public async purgeDeletedVaultObject(): Promise<void> {
    throw new ResourceOperationUnsupportedError("This vault has no deleted-items view");
  }
}
