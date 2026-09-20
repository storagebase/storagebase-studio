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
import type { BlobDownload, BlobObjectMeta, BlobOperations, BlobPreview } from "../../operations";
import { Readable } from "node:stream";

/**
 * The Azure Blob Storage provider. Authenticates with Microsoft Entra ID
 * (`ClientSecretCredential` matches the connection fields:
 * tenantId/clientId/clientSecret) against the account URL — either the
 * `endpoint` spelled out or `https://<vaultName>.blob.core.windows.net`.
 *
 * Tree mapping mirrors the S3 provider one level at a time: containers, then
 * `byHierarchy("/")` prefixes and blobs. Node ids carry the full address
 * (`container/<name>/<blob-or-prefix>`) under the same `splitNodeId` ruling.
 */

import { loadResourceSdk } from "../../sdk-loader";

type BlobModule = typeof import("@azure/storage-blob");
type IdentityModule = typeof import("@azure/identity");

function loadBlob(): Promise<BlobModule> {
  return loadResourceSdk<BlobModule>(
    "@azure/storage-blob",
    "Azure SDK (@azure/storage-blob)",
    "bun add @azure/storage-blob",
  );
}

function loadIdentity(): Promise<IdentityModule> {
  return loadResourceSdk<IdentityModule>("@azure/identity", "Azure SDK (@azure/identity)", "bun add @azure/identity");
}

export const AZURE_BLOB_LIST_LIMIT = 1000;

export const AZURE_BLOB_PREVIEW_LIMIT = 64 * 1024;

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Azure Blob ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "ContainerNotFound" || code === "BlobNotFound";
}

export class AzureBlobProvider extends BaseResourceProvider implements BlobOperations {
  private service: InstanceType<BlobModule["BlobServiceClient"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.endpoint && !this.config.vaultName) {
      throw new ResourceConfigError(
        'An Azure Blob connection requires an account "endpoint" or a "vaultName" (storage account name)',
      );
    }
    // Either Entra ID or the shared key — Azurite speaks no Entra ID, so the
    // key is the only credential the emulator takes, and refusing it would
    // leave the fixture unconnectable.
    const hasEntra = !!this.config.tenantId && !!this.config.clientId && !!this.config.clientSecret;
    if (!hasEntra && !this.config.accountKey) {
      throw new ResourceConfigError(
        "An Azure Blob connection requires Entra ID credentials (tenantId, clientId, clientSecret) or an accountKey",
      );
    }
  }

  private accountName(): string {
    if (this.config.vaultName) return this.config.vaultName;
    const host = (this.config.endpoint as string).split("://").pop()?.split("/")?.[0] ?? "";
    // Azurite addresses carry the account as the first path segment, real
    // accounts as the subdomain: both spellings resolve here, never guessed at
    // the call sites.
    if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) {
      return (this.config.endpoint as string).split("/").filter(Boolean).pop() ?? "";
    }
    return host.split(".")[0] ?? "";
  }

  private accountUrl(): string {
    // Passed through untouched: real accounts spell the name as the host,
    // Azurite spells it as the path (`/devstoreaccount1`), and the service
    // client wants the bare endpoint either way — stripping the path is what
    // broke Azurite (measured: "query parameters invalid" on list).
    if (this.config.endpoint) return this.config.endpoint.replace(/\/$/, "");
    return `https://${this.config.vaultName as string}.blob.core.windows.net`;
  }

  private async getService(): Promise<InstanceType<BlobModule["BlobServiceClient"]>> {
    if (this.service) return this.service;
    const [blob, identity] = await Promise.all([loadBlob(), loadIdentity()]);
    if (this.config.accountKey) {
      const sharedKey = new blob.StorageSharedKeyCredential(this.accountName(), this.config.accountKey);
      this.service = new blob.BlobServiceClient(this.accountUrl(), sharedKey);
    } else {
      const credential = new identity.ClientSecretCredential(
        this.config.tenantId as string,
        this.config.clientId as string,
        this.config.clientSecret as string,
      );
      this.service = new blob.BlobServiceClient(this.accountUrl(), credential);
    }
    return this.service;
  }

  public async connect(): Promise<void> {
    try {
      // REST, like S3: no socket to open. The probe is what fails an
      // unreachable account or a refused credential HERE as unreachable,
      // rather than later as degraded health on a connection that never was.
      await this.listBuckets();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    this.service = null;
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
      throw toConnectionError(error, "list containers");
    }
  }

  public async listObjects(bucket: string, prefix: string | null): Promise<ResourceNodePage> {
    try {
      const service = await this.getService();
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
      if (error instanceof ResourceNotFoundError) throw error;
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
      if (isMissing(error)) throw new ResourceNotFoundError(`Blob "${name}" does not exist in container "${bucket}"`);
      throw toConnectionError(error, `preview "${name}"`);
    }
  }

  public async uploadBlob(bucket: string, name: string, body: ReadableStream<Uint8Array>): Promise<BlobObjectMeta> {
    try {
      const service = await this.getService();
      const container = service.getContainerClient(bucket);
      if (!(await container.exists())) throw new ResourceNotFoundError(`Container "${bucket}" does not exist`);
      await container.getBlockBlobClient(name).uploadStream(toNodeStream(body));
      return this.readBlobMeta(bucket, name);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
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
      if (error instanceof ResourceNotFoundError) throw error;
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
