import { Readable } from "node:stream";
import { BaseResourceProvider } from "@/storagebase/resources/base-provider";
import { registerResourceProviderLoader } from "@/storagebase/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/storagebase/resources/errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNode,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "@/storagebase/resources/types";
import type { BlobDownload, BlobObjectMeta, BlobOperations, BlobPreview } from "@/storagebase/resources/operations";
import { loadResourceSdk } from "@/storagebase/resources/sdk-loader";

/**
 * The Azure Blob Storage provider (fork port of the legacy provider, moved by
 * path; see docs/storagebase/resources/azure-blob.md, the triad's doc side).
 *
 * Tree mapping mirrors the S3 provider one level at a time: containers, then
 * `byHierarchy("/")` prefixes and blobs. Node ids carry the full address
 * (`container/<name>/<blob-or-prefix>`) under the same `splitNodeId` ruling.
 *
 * Authentication is a resolved mode, not a guessed one
 * (`resolveAzureBlobAuthMode`, the single resolution point):
 *
 * | mode | credential | where the account comes from |
 * |---|---|---|
 * | `account-key` | `StorageSharedKeyCredential` | `endpoint`/`vaultName` |
 * | `connection-string` | the SDK's own `fromConnectionString` parser | the string itself |
 * | `sas-url` | the SAS token embedded in the URL | the URL itself |
 * | `client-secret` | `ClientSecretCredential` | `endpoint`/`vaultName` |
 * | `managed-identity` | `ManagedIdentityCredential` (`clientId` optional) | `endpoint`/`vaultName` |
 * | `workload-identity` | `WorkloadIdentityCredential` | `endpoint`/`vaultName` |
 *
 * An explicit `authMode` selects the mode and its required fields are
 * validated here. Without one, the first present credential wins in the
 * table's order, and a record with no credential at all resolves to
 * `workload-identity` — the in-cluster default this fork adds, so an AKS
 * deployment with workload identity federation needs no client secret in the
 * connection at all: the pod's `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
 * `AZURE_FEDERATED_TOKEN_FILE` drive the credential unless the record spells
 * `tenantId`/`clientId` itself.
 *
 * A SAS URL may be account-scoped (full surface) or container/blob-scoped,
 * in which case the connection is scoped to that one container: the tree
 * shows exactly it as its root, and other names answer 404, never a silent
 * empty listing. Azurite's account-as-first-path-segment spelling is
 * recognised the same way `accountName()` recognises it.
 */

/**
 * The @azure/storage-blob surface this provider touches, declared
 * structurally. The SDK sits in the fork's deps workspace
 * (packages/storagebase-deps, P8), which root-project tooling cannot resolve
 * type-only imports from — so the contract is spelled here, pinned by the
 * integration test's doubles, which are shaped from a live pass against
 * Azurite (see the doc page's testing section).
 */
interface BlobHierarchyPage {
  segment?: { blobPrefixes?: { name?: string }[]; blobItems?: { name?: string; properties?: BlobItemProperties }[] };
  continuationToken?: string;
}

interface BlobItemProperties {
  contentLength?: number;
  lastModified?: Date;
}

interface BlobDownloadResponse {
  readableStreamBody?: unknown;
  contentType?: string;
  contentLength?: number;
}

interface BlobClientLike {
  getProperties(): Promise<{ contentLength?: number; lastModified?: Date; contentType?: string }>;
  download(offset?: number, count?: number): Promise<BlobDownloadResponse>;
  exists(): Promise<boolean>;
  delete(): Promise<void>;
}

interface BlockBlobClientLike {
  uploadStream(stream: Readable, bufferSize?: number, maxConcurrency?: number): Promise<unknown>;
}

interface ContainerClientLike {
  exists(): Promise<boolean>;
  listBlobsByHierarchy(
    delimiter: string,
    options?: { prefix?: string },
  ): {
    byPage(settings?: { maxPageSize?: number }): AsyncIterable<BlobHierarchyPage>;
  };
  getBlobClient(name: string): BlobClientLike;
  getBlockBlobClient(name: string): BlockBlobClientLike;
}

export interface BlobServiceClientLike {
  listContainers(): {
    byPage(settings?: {
      maxPageSize?: number;
    }): AsyncIterable<{ containerItems?: { name: string }[]; continuationToken?: string }>;
  };
  getContainerClient(name: string): ContainerClientLike;
}

/** The constructor surface the provider calls; `fromConnectionString` is a static, not an instance member. */
interface BlobServiceClientConstructor {
  new (url: string, credential?: unknown, options?: unknown): BlobServiceClientLike;
  fromConnectionString(connectionString: string, options?: unknown): BlobServiceClientLike;
}

interface BlobSdkModule {
  BlobServiceClient: BlobServiceClientConstructor;
  StorageSharedKeyCredential: new (accountName: string, accountKey: string) => unknown;
}

interface IdentitySdkModule {
  ClientSecretCredential: new (tenantId: string, clientId: string, clientSecret: string) => unknown;
  ManagedIdentityCredential: new (clientId?: string) => unknown;
  WorkloadIdentityCredential: new (options?: { tenantId?: string; clientId?: string }) => unknown;
}

function loadBlob(): Promise<BlobSdkModule> {
  return loadResourceSdk<BlobSdkModule>(
    "@azure/storage-blob",
    "Azure SDK (@azure/storage-blob)",
    "bun add @azure/storage-blob",
  );
}

function loadIdentity(): Promise<IdentitySdkModule> {
  return loadResourceSdk<IdentitySdkModule>(
    "@azure/identity",
    "Azure SDK (@azure/identity)",
    "bun add @azure/identity",
  );
}

export const AZURE_BLOB_LIST_LIMIT = 1000;

export const AZURE_BLOB_PREVIEW_LIMIT = 64 * 1024;

/**
 * The block size and concurrency `uploadStream` is driven with. Blocks ×
 * concurrency is the provider's in-flight upload memory: 4 MiB × 5 = 20 MiB
 * held while a stream uploads, independent of the object's size (the route's
 * own cap, BLOB_UPLOAD_LIMIT, bounds what reaches the provider at all).
 */
export const AZURE_BLOB_UPLOAD_BLOCK_SIZE = 4 * 1024 * 1024;
export const AZURE_BLOB_UPLOAD_CONCURRENCY = 5;

/**
 * The auth modes this provider resolves. The record may select one
 * explicitly through `authMode`; every value is also reachable by field
 * precedence (see `resolveAzureBlobAuthMode`).
 */
export const AZURE_BLOB_AUTH_MODES = [
  "account-key",
  "connection-string",
  "sas-url",
  "client-secret",
  "managed-identity",
  "workload-identity",
] as const;

export type AzureBlobAuthMode = (typeof AZURE_BLOB_AUTH_MODES)[number];

/**
 * The fields this provider reads beyond the shared record: the fork's
 * `ResourceConnection` gains `sasUrl` and `authMode` with this phase (the
 * connection-body's sealed set treats `sasUrl` like `accountKey` and
 * `connectionString` — a credential, never echoed, never sent to the
 * browser). This local view keeps the provider's contract explicit while the
 * shared type lands; the constructor narrows once, documented here.
 */
export type AzureBlobConnection = ResourceConnection & {
  sasUrl?: string;
  authMode?: AzureBlobAuthMode;
};

/** What a `sasUrl` resolves to: the service URL the SDK client is built on, and the container a scoped token addresses. */
export interface AzureBlobSasScope {
  /** The account endpoint with the SAS query attached — derived container/blob clients inherit it. */
  readonly accountUrl: string;
  /** The container a container/blob-scoped token addresses; null for account SAS. */
  readonly container: string | null;
}

/**
 * The resolved mode with its fields already validated, so no call site
 * asserts or re-reads them. `sas` carries the parsed scope for the `sas-url`
 * mode only — the decision is the one place the URL is parsed.
 */
export type AzureBlobAuthDecision =
  | { readonly mode: "account-key"; readonly accountKey: string; readonly sas: null }
  | { readonly mode: "connection-string"; readonly connectionString: string; readonly sas: null }
  | { readonly mode: "sas-url"; readonly sas: AzureBlobSasScope }
  | {
      readonly mode: "client-secret";
      readonly tenantId: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly sas: null;
    }
  | { readonly mode: "managed-identity"; readonly clientId: string | null; readonly sas: null }
  | {
      readonly mode: "workload-identity";
      readonly tenantId: string | null;
      readonly clientId: string | null;
      readonly sas: null;
    };

function isLocalHost(host: string): boolean {
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

/**
 * Parse a SAS URL into the service URL and the container scope, without ever
 * echoing the URL (it carries the token). Both spellings are supported:
 * account SAS (`https://account.../?sig=…`, container null) and
 * container/blob SAS (`https://account…/<container>[/<blob>]?sig=…`,
 * container set; the token, not the parser, enforces what inside it is
 * readable). Azurite addresses carry the account as the first path segment —
 * the same host ruling `accountName()` applies — so on a local host the
 * first segment is the account and the second is the container.
 */
export function parseAzureBlobSasUrl(sasUrl: string): AzureBlobSasScope {
  let parsed: URL;
  try {
    parsed = new URL(sasUrl);
  } catch {
    throw new ResourceConfigError('"sasUrl" is not a valid URL');
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ResourceConfigError('"sasUrl" must be an http(s) URL');
  }
  if (!parsed.searchParams.has("sig")) {
    throw new ResourceConfigError('"sasUrl" must carry a SAS token (a "sig" query parameter)');
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Azurite spells the account as the first path segment; real accounts spell
  // it as the subdomain. Consumed, never guessed at the call sites.
  const accountSegment = isLocalHost(parsed.hostname) ? (segments.shift() ?? null) : null;
  const container = segments[0] ?? null;
  if (container === null) {
    // Account SAS: passed through untouched — the same measured Azurite
    // lesson as accountUrl(): stripping the path is what broke the emulator
    // ("query parameters invalid" on list), so only one trailing slash goes.
    return { accountUrl: sasUrl.replace(/\/$/, ""), container: null };
  }
  const accountBase = `${parsed.origin}${accountSegment === null ? "" : `/${accountSegment}`}`;
  return { accountUrl: `${accountBase}/?${parsed.searchParams.toString()}`, container };
}

/**
 * Resolve the connection's auth mode: the explicit `authMode` when present
 * (its required fields validated, an unknown value refused), else the first
 * present credential in a fixed precedence, else `workload-identity` — the
 * no-secret default for in-cluster deployments.
 */
export function resolveAzureBlobAuthMode(config: AzureBlobConnection): AzureBlobAuthDecision {
  if (config.authMode !== undefined) {
    if (!(AZURE_BLOB_AUTH_MODES as readonly string[]).includes(config.authMode)) {
      throw new ResourceConfigError(`Unknown "authMode"; the valid modes are: ${AZURE_BLOB_AUTH_MODES.join(", ")}`);
    }
    switch (config.authMode) {
      case "account-key": {
        if (!config.accountKey) throw new ResourceConfigError('authMode "account-key" requires an "accountKey"');
        return { mode: "account-key", accountKey: config.accountKey, sas: null };
      }
      case "connection-string": {
        if (!config.connectionString) {
          throw new ResourceConfigError('authMode "connection-string" requires a "connectionString"');
        }
        return { mode: "connection-string", connectionString: config.connectionString, sas: null };
      }
      case "sas-url": {
        if (!config.sasUrl) throw new ResourceConfigError('authMode "sas-url" requires a "sasUrl"');
        return { mode: "sas-url", sas: parseAzureBlobSasUrl(config.sasUrl) };
      }
      case "client-secret": {
        if (!config.tenantId || !config.clientId || !config.clientSecret) {
          throw new ResourceConfigError('authMode "client-secret" requires "tenantId", "clientId" and "clientSecret"');
        }
        return {
          mode: "client-secret",
          tenantId: config.tenantId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          sas: null,
        };
      }
      case "managed-identity": {
        // clientId optional: absent means the system-assigned identity.
        return { mode: "managed-identity", clientId: config.clientId ?? null, sas: null };
      }
      case "workload-identity": {
        // tenantId/clientId optional: absent lets the AKS-injected env drive the credential.
        return {
          mode: "workload-identity",
          tenantId: config.tenantId ?? null,
          clientId: config.clientId ?? null,
          sas: null,
        };
      }
    }
  }
  if (config.accountKey) return { mode: "account-key", accountKey: config.accountKey, sas: null };
  if (config.connectionString)
    return { mode: "connection-string", connectionString: config.connectionString, sas: null };
  if (config.sasUrl) return { mode: "sas-url", sas: parseAzureBlobSasUrl(config.sasUrl) };
  if (config.tenantId && config.clientId && config.clientSecret) {
    return {
      mode: "client-secret",
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      sas: null,
    };
  }
  return { mode: "workload-identity", tenantId: config.tenantId ?? null, clientId: config.clientId ?? null, sas: null };
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Azure Blob ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "ContainerNotFound" || code === "BlobNotFound";
}

/**
 * The provider's own typed refusals pass through every wrapping catch: a
 * config mistake (a malformed connectionString parsed at first use) stays a
 * 400 wherever it first surfaces, never re-labelled as a connection failure.
 */
function isOwnRefusal(error: unknown): boolean {
  return error instanceof ResourceConfigError || error instanceof ResourceNotFoundError;
}

export class AzureBlobProvider extends BaseResourceProvider implements BlobOperations {
  private service: BlobServiceClientLike | null = null;
  /** The container a scoped SAS addresses, set with the service client; null on every other mode. */
  private sasContainer: string | null = null;

  /**
   * The connection narrowed to this provider's field view — one documented
   * narrowing; every read below goes through it so `sasUrl`/`authMode` have
   * exactly one declared home.
   */
  private get blobConfig(): AzureBlobConnection {
    return this.config as AzureBlobConnection;
  }

  protected validate(): void {
    super.validate();
    const decision = resolveAzureBlobAuthMode(this.blobConfig);
    // The self-contained modes carry their own account; every other mode
    // needs the account spelled out as endpoint or vaultName.
    const selfAddressed = decision.mode === "connection-string" || decision.mode === "sas-url";
    if (!selfAddressed && !this.blobConfig.endpoint && !this.blobConfig.vaultName) {
      throw new ResourceConfigError(
        'An Azure Blob connection requires an account "endpoint" or a "vaultName" (storage account name) unless a connectionString or sasUrl carries the account',
      );
    }
  }

  private accountName(): string {
    if (this.blobConfig.vaultName) return this.blobConfig.vaultName;
    const host = (this.blobConfig.endpoint as string).split("://").pop()?.split("/")?.[0] ?? "";
    // Azurite addresses carry the account as the first path segment, real
    // accounts as the subdomain: both spellings resolve here, never guessed at
    // the call sites.
    if (isLocalHost(host)) {
      return (this.blobConfig.endpoint as string).split("/").filter(Boolean).pop() ?? "";
    }
    return host.split(".")[0] ?? "";
  }

  private accountUrl(): string {
    // Passed through untouched: real accounts spell the name as the host,
    // Azurite spells it as the path (`/devstoreaccount1`), and the service
    // client wants the bare endpoint either way — stripping the path is what
    // broke Azurite (measured: "query parameters invalid" on list).
    if (this.blobConfig.endpoint) return this.blobConfig.endpoint.replace(/\/$/, "");
    return `https://${this.blobConfig.vaultName as string}.blob.core.windows.net`;
  }

  private async getService(): Promise<BlobServiceClientLike> {
    if (this.service) return this.service;
    const [blob, identity] = await Promise.all([loadBlob(), loadIdentity()]);
    const decision = resolveAzureBlobAuthMode(this.blobConfig);
    let service: BlobServiceClientLike;
    switch (decision.mode) {
      case "account-key": {
        // Azurite speaks no Entra ID, so the key is the only credential the
        // emulator takes — kept first in the precedence for that reason.
        const sharedKey = new blob.StorageSharedKeyCredential(this.accountName(), decision.accountKey);
        service = new blob.BlobServiceClient(this.accountUrl(), sharedKey);
        break;
      }
      case "connection-string": {
        // The SDK's own parser (AccountEndpoint/AccountKey or
        // SharedAccessSignature triples). A malformed string is a config
        // mistake: rethrown as ResourceConfigError, without echoing the string
        // — it carries the key.
        try {
          service = blob.BlobServiceClient.fromConnectionString(decision.connectionString);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ResourceConfigError(`The "connectionString" could not be parsed: ${message}`);
        }
        break;
      }
      case "sas-url": {
        // The SAS query rides in the service URL, so every container/blob
        // client derived from it (appendToURLPath keeps the query) is signed.
        service = new blob.BlobServiceClient(decision.sas.accountUrl);
        break;
      }
      case "client-secret": {
        const credential = new identity.ClientSecretCredential(
          decision.tenantId,
          decision.clientId,
          decision.clientSecret,
        );
        service = new blob.BlobServiceClient(this.accountUrl(), credential);
        break;
      }
      case "managed-identity": {
        // User-assigned when clientId is present, the pod's system-assigned identity otherwise.
        const credential = new identity.ManagedIdentityCredential(decision.clientId ?? undefined);
        service = new blob.BlobServiceClient(this.accountUrl(), credential);
        break;
      }
      case "workload-identity": {
        // The in-cluster default: the record's tenantId/clientId when it
        // spells them, the AKS-injected env when it does not — the token file
        // itself always comes from AZURE_FEDERATED_TOKEN_FILE.
        const credential = new identity.WorkloadIdentityCredential({
          ...(decision.tenantId === null ? {} : { tenantId: decision.tenantId }),
          ...(decision.clientId === null ? {} : { clientId: decision.clientId }),
        });
        service = new blob.BlobServiceClient(this.accountUrl(), credential);
        break;
      }
    }
    this.service = service;
    this.sasContainer = decision.mode === "sas-url" ? decision.sas.container : null;
    return service;
  }

  /**
   * The connect/health probe is the tree's own root read (`listBuckets`):
   * REST like S3, no socket to open, and it is what fails an unreachable
   * account or a refused credential HERE as unreachable, rather than later as
   * degraded health on a connection that never was. For a scoped SAS the same
   * call probes the scoped container's existence instead — the root read IS
   * the probe.
   */
  public async connect(): Promise<void> {
    try {
      await this.listBuckets();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      if (isOwnRefusal(error)) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    this.service = null;
    this.sasContainer = null;
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    await this.listBuckets();
    return { status: "healthy", latencyMs: Date.now() - start };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "blob",
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "blob.read", "blob.download", "blob.upload", "blob.delete"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Containers", itemNoun: "Blobs" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId === null) return this.listBuckets();
    const { bucket, prefix } = splitNodeId(parentId);
    return this.listObjects(bucket, prefix);
  }

  public async listBuckets(): Promise<ResourceNodePage> {
    try {
      const service = await this.getService();
      if (this.sasContainer !== null) {
        // A container/blob-scoped SAS addresses exactly one container: the
        // tree's root IS it. Existence is probed so a dead scope answers 404
        // rather than an existing-looking container with nothing in it.
        if (!(await service.getContainerClient(this.sasContainer).exists())) {
          throw new ResourceNotFoundError(`Container "${this.sasContainer}" does not exist`);
        }
        return {
          nodes: [
            {
              id: `container/${this.sasContainer}`,
              parentId: null,
              kind: "container",
              name: this.sasContainer,
              hasChildren: true,
            },
          ],
          truncated: false,
        };
      }
      const nodes: ResourceNode[] = [];
      // One page plus a peek, the same ruling as listObjects below: the peek
      // is what makes `truncated` measured rather than assumed.
      const pages = service.listContainers().byPage({ maxPageSize: AZURE_BLOB_LIST_LIMIT });
      const first = await pages[Symbol.asyncIterator]().next();
      const page = first.value;
      for (const container of page?.containerItems ?? []) {
        nodes.push({
          id: `container/${container.name}`,
          parentId: null,
          kind: "container",
          name: container.name,
          hasChildren: true,
        });
      }
      // The service's own continuation marker, read off the page — no second
      // request, and no empty-marker peek (which Azurite rejects). Empty means
      // the listing ended here; anything else means it did not.
      const continuation = page?.continuationToken ?? "";
      return { nodes, truncated: continuation !== "" };
    } catch (error) {
      if (isOwnRefusal(error)) throw error;
      throw toConnectionError(error, "list containers");
    }
  }

  public async listObjects(bucket: string, prefix: string | null): Promise<ResourceNodePage> {
    try {
      const service = await this.getService();
      if (this.sasContainer !== null && bucket !== this.sasContainer) {
        // The token cannot read other containers; the tree says so instead of
        // answering an empty listing for a name the scope never covered.
        throw new ResourceNotFoundError(
          `This connection is scoped to container "${this.sasContainer}" and cannot list "${bucket}"`,
        );
      }
      const container = service.getContainerClient(bucket);
      // A missing container answers at first read, not as an empty listing:
      // without this the tree would show an existing-looking container with
      // nothing in it, which is the D31 lie in another costume.
      if (!(await container.exists())) throw new ResourceNotFoundError(`Container "${bucket}" does not exist`);
      const base = prefix === null ? `container/${bucket}` : `container/${bucket}/${prefix}`;
      const nodes: ResourceNode[] = [];
      // One page; the continuation marker is the truncation verdict (same
      // ruling as listBuckets: no empty-marker peek, which Azurite rejects).
      const pages = container.listBlobsByHierarchy("/", { prefix: prefix ?? undefined }).byPage({
        maxPageSize: AZURE_BLOB_LIST_LIMIT,
      });
      const first = await pages[Symbol.asyncIterator]().next();
      const page = first.value;
      for (const item of page?.segment?.blobPrefixes ?? []) {
        if (item.name === undefined) continue;
        const name = item.name.slice((prefix ?? "").length).replace(/\/$/, "");
        nodes.push({ id: childId(base, name, true), parentId: base, kind: "prefix", name, hasChildren: true });
      }
      for (const item of page?.segment?.blobItems ?? []) {
        if (item.name === undefined || item.name === prefix) continue;
        const name = item.name.slice((prefix ?? "").length);
        nodes.push({
          id: childId(base, name, false),
          parentId: base,
          kind: "blob",
          name,
          meta: {
            ...(item.properties?.contentLength !== undefined ? { size: item.properties.contentLength } : {}),
            ...(item.properties?.lastModified ? { modified: item.properties.lastModified.toISOString() } : {}),
          },
          hasChildren: false,
        });
      }
      const continuation = page?.continuationToken ?? "";
      return { nodes, truncated: continuation !== "" };
    } catch (error) {
      if (isOwnRefusal(error)) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Container "${bucket}" does not exist`);
      throw toConnectionError(error, `list blobs in "${bucket}"`);
    }
  }

  public async readBlobMeta(bucket: string, name: string): Promise<BlobObjectMeta> {
    try {
      const service = await this.getService();
      const blob = service.getContainerClient(bucket).getBlobClient(name);
      const properties = await blob.getProperties();
      return {
        id: `container/${bucket}/${name}`,
        name,
        sizeBytes: properties.contentLength ?? null,
        lastModified: properties.lastModified?.toISOString() ?? null,
        contentType: properties.contentType ?? null,
      };
    } catch (error) {
      if (isOwnRefusal(error)) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Blob "${name}" does not exist in container "${bucket}"`);
      throw toConnectionError(error, `read "${name}"`);
    }
  }

  public async downloadBlob(bucket: string, name: string): Promise<BlobDownload> {
    try {
      const service = await this.getService();
      const blob = service.getContainerClient(bucket).getBlobClient(name);
      const response = await blob.download();
      if (response.readableStreamBody === undefined) {
        throw new ResourceConnectionError(`Azure download of "${name}" answered no body`);
      }
      return {
        body: toWebStream(response.readableStreamBody),
        contentType: response.contentType ?? null,
        sizeBytes: response.contentLength ?? null,
      };
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      if (isOwnRefusal(error)) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Blob "${name}" does not exist in container "${bucket}"`);
      throw toConnectionError(error, `download "${name}"`);
    }
  }

  public async previewBlob(bucket: string, name: string, byteLimit: number): Promise<BlobPreview> {
    const limit = Math.max(1, Math.min(byteLimit, AZURE_BLOB_PREVIEW_LIMIT));
    try {
      const service = await this.getService();
      const blob = service.getContainerClient(bucket).getBlobClient(name);
      // Range reads keep previews honest about cost: never the whole blob.
      const response = await blob.download(0, limit + 1);
      const contentType = response.contentType ?? null;
      if (contentType?.startsWith("image/") === true) {
        return { kind: "image", truncated: false, contentType };
      }
      const bytes = await readUpTo(toWebStream(response.readableStreamBody), limit + 1);
      const truncated = bytes.length > limit;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit));
      const kind = text.includes("�") ? "binary" : "text";
      return { kind, ...(kind === "text" ? { text } : {}), truncated, contentType };
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      if (isOwnRefusal(error)) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Blob "${name}" does not exist in container "${bucket}"`);
      throw toConnectionError(error, `preview "${name}"`);
    }
  }

  public async uploadBlob(bucket: string, name: string, body: ReadableStream<Uint8Array>): Promise<BlobObjectMeta> {
    try {
      const service = await this.getService();
      const container = service.getContainerClient(bucket);
      if (!(await container.exists())) throw new ResourceNotFoundError(`Container "${bucket}" does not exist`);
      await container
        .getBlockBlobClient(name)
        .uploadStream(toNodeStream(body), AZURE_BLOB_UPLOAD_BLOCK_SIZE, AZURE_BLOB_UPLOAD_CONCURRENCY);
      return this.readBlobMeta(bucket, name);
    } catch (error) {
      if (isOwnRefusal(error)) throw error;
      throw toConnectionError(error, `upload "${name}"`);
    }
  }

  public async deleteBlob(bucket: string, name: string): Promise<void> {
    try {
      const service = await this.getService();
      const blob = service.getContainerClient(bucket).getBlobClient(name);
      if (!(await blob.exists())) throw new ResourceNotFoundError(`Blob "${name}" does not exist`);
      await blob.delete();
    } catch (error) {
      if (isOwnRefusal(error)) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Blob "${name}" does not exist in container "${bucket}"`);
      throw toConnectionError(error, `delete "${name}"`);
    }
  }
}

/**
 * Join a child name onto a level address. Prefix parents end in `/`,
 * container roots do not; the join respects either so ids never double-slash
 * (measured against Azurite: `nested//dir/` before this helper existed).
 */
function childId(base: string, name: string, isPrefix: boolean): string {
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${name}${isPrefix ? "/" : ""}`;
}

/**
 * Split a tree node id back into its container and prefix. Ids are built as
 * `container/<name>` and `container/<name>/<blob-or-prefix>`, and container
 * names never contain `/`, so the first segment after `container/` is always
 * the container.
 */
export function splitNodeId(nodeId: string): { bucket: string; prefix: string | null } {
  const rest = nodeId.startsWith("container/") ? nodeId.slice("container/".length) : nodeId;
  const slash = rest.indexOf("/");
  if (slash === -1) return { bucket: rest, prefix: null };
  const prefix = rest.slice(slash + 1);
  return { bucket: rest.slice(0, slash), prefix: prefix === "" ? null : prefix };
}

/** The contract carries a web stream; `uploadStream` wants a node Readable. */
function toNodeStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  const stream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        this.push(done || value === undefined ? null : Buffer.from(value));
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  stream.on("close", () => void reader.cancel().catch(() => undefined));
  return stream;
}

/** The SDK answers node Readables; reads of them come back as web streams. */
function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body === undefined || body === null) {
    throw new ResourceConnectionError("Azure download answered no body");
  }
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  const nodeReadable = body as { [Symbol.asyncIterator](): AsyncIterator<unknown> };
  const iterator = nodeReadable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done || value === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(value as Uint8Array);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function readUpTo(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

registerResourceProviderLoader("azure-blob", () =>
  import("./azure-blob").then((m) => ({ default: m.AzureBlobProvider })),
);
