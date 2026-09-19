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

/**
 * The Amazon S3 provider — and, through the endpoint override, every
 * S3-compatible endpoint (MinIO, Cloudflare R2, DigitalOcean Spaces): wire
 * relatives, not separate type-ids (STORAGEBASE.md). The override forces path
 * style, the way the Valkey precedent forces its own addressing quirk in one
 * place.
 */

type S3Module = typeof import("@aws-sdk/client-s3");

let s3Module: S3Module | null = null;

async function loadS3(): Promise<S3Module> {
  if (s3Module) return s3Module;
  try {
    s3Module = await import("@aws-sdk/client-s3");
    return s3Module;
  } catch {
    throw new ResourceConfigError(
      "AWS SDK (@aws-sdk/client-s3) is not available in this environment. Install it with: bun add @aws-sdk/client-s3",
    );
  }
}

/** Objects per tree level — the bound the page's `truncated` flag reports. */
export const S3_LIST_LIMIT = 1000;

/** Preview reads at most this many bytes before calling the body truncated. */
export const S3_PREVIEW_LIMIT = 64 * 1024;

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`S3 ${what} failed: ${message}`);
}

function isMissing(error: unknown): boolean {
  const code = (error as { Code?: string; $metadata?: { httpStatusCode?: number } })?.Code;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return code === "NoSuchKey" || code === "NoSuchBucket" || status === 404;
}

export class S3Provider extends BaseResourceProvider implements BlobOperations {
  private client: InstanceType<S3Module["S3Client"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.region && !this.config.endpoint) {
      throw new ResourceConfigError('An S3 connection requires a "region" or an S3-compatible "endpoint" override');
    }
  }

  private async getClient(): Promise<InstanceType<S3Module["S3Client"]>> {
    if (this.client) return this.client;
    const sdk = await loadS3();
    this.client = new sdk.S3Client({
      region: this.config.region || "us-east-1",
      ...(this.config.endpoint ? { endpoint: this.config.endpoint, forcePathStyle: true } : {}),
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
      // S3 is REST: there is no socket to open. The probe below is what makes
      // an unreachable endpoint fail HERE as unreachable, rather than later as
      // a degraded health read that claims a connection exists.
      await this.listBuckets();
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
    return { containerNoun: "Buckets", itemNoun: "Objects" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId === null) return this.listBuckets();
    const { bucket, prefix } = splitNodeId(parentId);
    return this.listObjects(bucket, prefix);
  }

  public async listBuckets(): Promise<ResourceNodePage> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      const { Buckets = [] } = await client.send(new sdk.ListBucketsCommand({}));
      const nodes: ResourceNode[] = (Buckets ?? [])
        .filter((bucket) => bucket.Name !== undefined)
        .map((bucket) => ({
          id: `bucket/${bucket.Name as string}`,
          parentId: null,
          kind: "bucket",
          name: bucket.Name as string,
          meta: bucket.CreationDate ? { created: bucket.CreationDate.toISOString() } : undefined,
          hasChildren: true,
        }));
      return { nodes, truncated: false };
    } catch (error) {
      throw toConnectionError(error, "list buckets");
    }
  }

  public async listObjects(bucket: string, prefix: string | null): Promise<ResourceNodePage> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      const response = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix ?? "",
          Delimiter: "/",
          MaxKeys: S3_LIST_LIMIT,
        }),
      );
      // Node ids carry the full address so a restored tree re-reads; every
      // node on this level is a child of the level's own address (`base`).
      // The join respects a trailing slash the parent id already carries
      // (prefix parents end in `/`, bucket roots do not), so ids never
      // double-slash and `splitNodeId` always round-trips.
      const base = prefix === null ? `bucket/${bucket}` : `bucket/${bucket}/${prefix}`;
      const nodes: ResourceNode[] = [
        ...(response.CommonPrefixes ?? [])
          .filter((common) => common.Prefix !== undefined)
          .map((common) => {
            const prefixName = common.Prefix as string;
            const name = prefixName.slice((prefix ?? "").length).replace(/\/$/, "");
            return {
              id: childId(base, name, true),
              parentId: base,
              kind: "prefix",
              name,
              hasChildren: true,
            };
          }),
        ...(response.Contents ?? [])
          .filter((object) => object.Key !== undefined && object.Key !== prefix)
          .map((object) => {
            const name = (object.Key as string).slice((prefix ?? "").length);
            return {
              id: childId(base, name, false),
              parentId: base,
              kind: "object",
              name,
              meta: {
                ...(object.Size !== undefined ? { size: object.Size } : {}),
                ...(object.LastModified ? { modified: object.LastModified.toISOString() } : {}),
              },
              hasChildren: false,
            };
          }),
      ];
      return { nodes, truncated: response.IsTruncated === true };
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Bucket "${bucket}" does not exist`);
      throw toConnectionError(error, `list objects in "${bucket}"`);
    }
  }

  public async readBlobMeta(bucket: string, name: string): Promise<BlobObjectMeta> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      const head = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: name }));
      return {
        id: `bucket/${bucket}/${name}`,
        name,
        sizeBytes: head.ContentLength ?? null,
        lastModified: head.LastModified?.toISOString() ?? null,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Object "${name}" does not exist in bucket "${bucket}"`);
      throw toConnectionError(error, `read "${name}"`);
    }
  }

  public async downloadBlob(bucket: string, name: string): Promise<BlobDownload> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      const response = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: name }));
      if (response.Body === undefined) throw new ResourceConnectionError(`S3 download of "${name}" answered no body`);
      return {
        body: toWebStream(response.Body),
        contentType: response.ContentType ?? null,
        sizeBytes: response.ContentLength ?? null,
      };
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Object "${name}" does not exist in bucket "${bucket}"`);
      throw toConnectionError(error, `download "${name}"`);
    }
  }

  public async previewBlob(bucket: string, name: string, byteLimit: number): Promise<BlobPreview> {
    const limit = Math.max(1, Math.min(byteLimit, S3_PREVIEW_LIMIT));
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      const response = await client.send(
        new sdk.GetObjectCommand({ Bucket: bucket, Key: name, Range: `bytes=0-${limit}` }),
      );
      if (response.Body === undefined) throw new ResourceConnectionError(`S3 preview of "${name}" answered no body`);
      const contentType = response.ContentType ?? null;
      if (contentType?.startsWith("image/") === true) {
        return { kind: "image", truncated: false, contentType };
      }
      const bytes = await readUpTo(toWebStream(response.Body), limit + 1);
      const truncated = bytes.length > limit;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit));
      // A body that does not survive UTF-8 is binary, not text the viewer can show.
      const kind = text.includes("�") ? "binary" : "text";
      return { kind, ...(kind === "text" ? { text } : {}), truncated, contentType };
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      if (isMissing(error)) throw new ResourceNotFoundError(`Object "${name}" does not exist in bucket "${bucket}"`);
      throw toConnectionError(error, `preview "${name}"`);
    }
  }

  public async uploadBlob(bucket: string, name: string, body: ReadableStream<Uint8Array>): Promise<BlobObjectMeta> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: name, Body: body }));
      return this.readBlobMeta(bucket, name);
    } catch (error) {
      if (isMissing(error)) throw new ResourceNotFoundError(`Bucket "${bucket}" does not exist`);
      throw toConnectionError(error, `upload "${name}"`);
    }
  }

  public async deleteBlob(bucket: string, name: string): Promise<void> {
    try {
      const client = await this.getClient();
      const sdk = await loadS3();
      // S3 deletes are idempotent: removing a missing key still answers 204,
      // so existence is checked first and a missing object is a 404, not silence.
      await this.readBlobMeta(bucket, name);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: name }));
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `delete "${name}"`);
    }
  }
}

/**
 * Join a child name onto a level address. Prefix parents end in `/`, bucket
 * roots do not; the join respects either so ids never double-slash.
 */
function childId(base: string, name: string, isPrefix: boolean): string {
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${name}${isPrefix ? "/" : ""}`;
}

/**
 * Split a tree node id back into its bucket and prefix. Ids are built as
 * `bucket/<name>` and `bucket/<name>/<key-or-prefix>`, and bucket names never
 * contain `/`, so the first segment after `bucket/` is always the bucket.
 */
export function splitNodeId(nodeId: string): { bucket: string; prefix: string | null } {
  const rest = nodeId.startsWith("bucket/") ? nodeId.slice("bucket/".length) : nodeId;
  const slash = rest.indexOf("/");
  if (slash === -1) return { bucket: rest, prefix: null };
  const prefix = rest.slice(slash + 1);
  return { bucket: rest.slice(0, slash), prefix: prefix === "" ? null : prefix };
}

/** The SDK answers node Readables; the contract is a web stream. */
function toWebStream(body: unknown): ReadableStream<Uint8Array> {
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

registerResourceProviderLoader("s3", () => import("./s3").then((m) => ({ default: m.S3Provider })));
