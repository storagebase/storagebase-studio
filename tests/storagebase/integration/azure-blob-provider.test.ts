import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider, clearResourceProviderCache } from "@/storagebase/resources/factory";
import { registeredResourceTypes } from "@/storagebase/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/storagebase/resources/errors";
import type { AzureBlobConnection } from "@/storagebase/resources/providers/blob/azure-blob";

/**
 * Azure Blob provider tests (fork port of the legacy integration test, moved
 * by path and widened for the auth-mode matrix). The fork spine is REAL here
 * (base-provider, registry, factory, sdk-loader); only the two Azure SDK
 * modules are doubled with `mock.module`; every answer below is shaped from
 * a live pass against Azurite (see the doc page's testing section), recorded
 * 2026-09-20:
 * - Hierarchy levels answer `blobPrefixes` + `blobItems` together; kinds are
 *   "prefix"/"blob". The page carries `continuationToken: ""` when done —
 *   that marker (not a second request) is the truncation verdict, because
 *   Azurite rejects the empty-marker peek with "query parameters invalid".
 * - A missing blob on getProperties answers statusCode 404 with an EMPTY
 *   message and no code — the provider must read the status, not the text.
 * - `exists()` answers plain booleans; the provider pre-checks existence so
 *   a missing container/blob is a 404 with the provider's own sentence.
 *
 * The auth-mode additions (workload identity default, managed identity, SAS
 * URL scope, connection string) have no emulator: their doubles assert the
 * constructor arguments the provider hands the SDKs, which is the whole of
 * what this layer can measure without a live Entra tenant.
 */

function toStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A stream that yields one chunk then errors: exercises toNodeStream's destroy arm. */
function toFailingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("half"));
      controller.error(new Error("upload aborted"));
    },
  });
}

/**
 * A node-style async-iterable body — what the SDK actually answers. The
 * provider converts it to the contract's web stream; a web stream here would
 * leave that conversion uncovered.
 */
function nodeStyleBytes(bytes: Uint8Array): unknown {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

function azureError(statusCode: number, message: string, code?: string) {
  const error = new Error(message) as Error & { statusCode: number; code?: string };
  error.statusCode = statusCode;
  if (code !== undefined) error.code = code;
  return error;
}

const FIXTURE_PREFIXES = [{ name: "nested/" }];
const FIXTURE_BLOBS = [
  {
    name: "hello.txt",
    properties: {
      contentLength: 18,
      contentType: "application/octet-stream",
      lastModified: new Date("2026-09-20T00:41:02.000Z"),
    },
  },
];

interface CapturedUpload {
  container: string;
  name: string;
  bytes: string;
  bufferSize?: number;
  maxConcurrency?: number;
  streamError: boolean;
}

const capturedServiceArgs: Array<{ url: string; credential: string }> = [];
const uploaded: CapturedUpload[] = [];
const deleted: Array<{ container: string; name: string }> = [];
let listContainersCalls = 0;

class FakeCredential {
  constructor(public readonly kind: string) {}
}

class FakeBlobClient {
  constructor(
    private readonly container: string,
    private readonly name: string,
  ) {}
  async getProperties() {
    if (
      this.name !== "hello.txt" &&
      this.name !== "photo.png" &&
      this.name !== "blob.bin" &&
      this.name !== "big.txt" &&
      this.name !== "nobody.txt"
    ) {
      throw azureError(404, "");
    }
    if (this.name === "photo.png") {
      return {
        contentLength: 7,
        contentType: "image/png",
        lastModified: new Date("2026-09-20T00:41:02.000Z"),
      };
    }
    if (this.name === "big.txt") {
      return {
        contentLength: 200,
        contentType: "text/plain",
        lastModified: new Date("2026-09-20T00:41:02.000Z"),
      };
    }
    return {
      contentLength: 18,
      contentType: "application/octet-stream",
      lastModified: new Date("2026-09-20T00:41:02.000Z"),
    };
  }
  async download(offset?: number, count?: number) {
    if (
      this.name !== "hello.txt" &&
      this.name !== "nobody.txt" &&
      this.name !== "photo.png" &&
      this.name !== "blob.bin" &&
      this.name !== "big.txt"
    ) {
      throw azureError(404, "");
    }
    if (this.name === "nobody.txt") {
      // Answers 200 with no body: the provider's guard, not a 404.
      return { contentType: "application/octet-stream", contentLength: 0 };
    }
    if (this.name === "photo.png") {
      // A web ReadableStream body — the SDK's browser shape; the provider
      // passes it through untouched.
      return {
        readableStreamBody: toStream("PNGDATA"),
        contentType: "image/png",
        contentLength: 7,
        _offset: offset,
        _count: count,
      };
    }
    if (this.name === "blob.bin") {
      return {
        readableStreamBody: nodeStyleBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x41])),
        contentType: "application/octet-stream",
        contentLength: 4,
        _offset: offset,
        _count: count,
      };
    }
    if (this.name === "big.txt") {
      // A body longer than any preview limit: the reader's early-break and
      // the truncated verdict are what this blob is for.
      return {
        readableStreamBody: nodeStyleBytes(new TextEncoder().encode("y".repeat(200))),
        contentType: "text/plain",
        contentLength: 200,
        _offset: offset,
        _count: count,
      };
    }
    // Full downloads pass no range; previews pass (0, limit+1). The count is
    // recorded so tests can tell the two apart. The body is node-style, like
    // the SDK answers, so the provider's conversion is what gets exercised.
    return {
      readableStreamBody: nodeStyleBytes(new TextEncoder().encode("hello storagebase\n")),
      contentType: "application/octet-stream",
      contentLength: 18,
      contentRange: "bytes 0-17/18",
      _offset: offset,
      _count: count,
    };
  }
  async exists() {
    return this.name === "hello.txt";
  }
  async delete() {
    deleted.push({ container: this.container, name: this.name });
  }
}

class FakeContainerClient {
  constructor(private readonly name: string) {}
  async exists() {
    return this.name === "fixture";
  }
  listBlobsByHierarchy = (_delimiter: string, options?: { prefix?: string }) => {
    return {
      byPage: (_settings?: { maxPageSize?: number }) => {
        const containerName = this.name;
        return {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next() {
                if (done) return { done: true, value: undefined };
                done = true;
                if (containerName !== "fixture") throw azureError(404, "", "ContainerNotFound");
                const prefix = options?.prefix ?? "";
                if (prefix !== "" && prefix !== "nested/") {
                  return {
                    done: false,
                    value: { segment: { blobPrefixes: [], blobItems: [] }, continuationToken: "" },
                  };
                }
                return {
                  done: false,
                  value: {
                    segment: {
                      blobPrefixes: prefix === "" ? FIXTURE_PREFIXES : [],
                      blobItems: prefix === "" ? FIXTURE_BLOBS.slice(0, 0) : FIXTURE_BLOBS,
                    },
                    continuationToken: "",
                  },
                };
              },
            };
          },
        };
      },
    };
  };
  getBlobClient(name: string) {
    return new FakeBlobClient(this.name, name);
  }
  getBlockBlobClient(name: string) {
    const container = this.name;
    return {
      async uploadStream(stream: unknown, bufferSize?: number, maxConcurrency?: number) {
        // Consumed, not ignored: the provider converts the contract's web
        // stream to node here, and an unread stream would leave that
        // conversion uncovered while asserting nothing about the bytes. A
        // stream that errors mid-read rejects like the SDK does, after the
        // chunks it already saw have been recorded.
        const chunks: Uint8Array[] = [];
        let streamError: unknown = null;
        try {
          for await (const chunk of stream as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
        } catch (error) {
          streamError = error;
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        uploaded.push({
          container,
          name,
          bytes: new TextDecoder().decode(body),
          bufferSize,
          maxConcurrency,
          streamError: streamError !== null,
        });
        if (streamError !== null) throw streamError;
      },
    };
  }
}

class FakeBlobServiceClient {
  constructor(
    private readonly url: string,
    credential?: FakeCredential,
  ) {
    capturedServiceArgs.push({ url, credential: credential === undefined ? "sas-in-url" : credential.kind });
  }
  static fromConnectionString(connectionString: string): FakeBlobServiceClient {
    // The SDK's own parser refuses a string with no key=value pairs; the
    // provider must rethrow that refusal as a config mistake.
    if (!connectionString.includes("=")) {
      throw new Error("Connection string must use key=value pairs");
    }
    const endpoint = /AccountEndpoint=([^;]+)/.exec(connectionString)?.[1] ?? "https://csaccount.blob.core.windows.net";
    return new FakeBlobServiceClient(endpoint);
  }
  listContainers() {
    const url = this.url;
    return {
      byPage(_settings?: { maxPageSize?: number }) {
        return {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next() {
                if (done) return { done: true, value: undefined };
                done = true;
                listContainersCalls += 1;
                if (url.includes("localhost:1")) throw azureError(500, "socket refused");
                return {
                  done: false,
                  value: { containerItems: [{ name: "fixture" }], continuationToken: "" },
                };
              },
            };
          },
        };
      },
    };
  }
  getContainerClient(name: string) {
    return new FakeContainerClient(name);
  }
}

mock.module("@azure/storage-blob", () => ({
  BlobServiceClient: FakeBlobServiceClient,
  StorageSharedKeyCredential: class extends FakeCredential {
    constructor(account: string, _key: string) {
      super(`shared-key:${account}`);
    }
  },
}));

mock.module("@azure/identity", () => ({
  ClientSecretCredential: class extends FakeCredential {
    constructor(tenant: string, _client: string, _secret: string) {
      super(`aad:${tenant}`);
    }
  },
  ManagedIdentityCredential: class extends FakeCredential {
    constructor(clientId?: string) {
      super(clientId === undefined ? "managed:system" : `managed:${clientId}`);
    }
  },
  WorkloadIdentityCredential: class extends FakeCredential {
    constructor(options?: { tenantId?: string; clientId?: string }) {
      super(`workload:${options?.tenantId ?? "env"}/${options?.clientId ?? "env"}`);
    }
  },
}));

// Importing the provider module self-registers the azure-blob loader in the
// REAL registry, like production; the factory test resolves through it.
const {
  AZURE_BLOB_LIST_LIMIT,
  AZURE_BLOB_PREVIEW_LIMIT,
  AZURE_BLOB_UPLOAD_BLOCK_SIZE,
  AZURE_BLOB_UPLOAD_CONCURRENCY,
  AzureBlobProvider,
  splitNodeId,
} = await import("@/storagebase/resources/providers/blob/azure-blob");

const keyConnection: AzureBlobConnection = {
  id: "res-1",
  name: "azurite",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:10000/devstoreaccount1",
  accountKey: "devstorekey",
};

const aadConnection: AzureBlobConnection = {
  id: "res-2",
  name: "azure",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
};

const sasAccountConnection: AzureBlobConnection = {
  id: "res-3",
  name: "sas-account",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  sasUrl: "https://myaccount.blob.core.windows.net/?sig=token",
};

const sasContainerConnection: AzureBlobConnection = {
  id: "res-4",
  name: "sas-container",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  sasUrl: "http://127.0.0.1:10000/devstoreaccount1/fixture?sig=token",
};

const connectionStringConnection: AzureBlobConnection = {
  id: "res-5",
  name: "cs",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  connectionString: "AccountEndpoint=https://csaccount.blob.core.windows.net;AccountKey=a2V5",
};

describe("AzureBlobProvider", () => {
  beforeEach(() => {
    capturedServiceArgs.length = 0;
    uploaded.length = 0;
    deleted.length = 0;
    listContainersCalls = 0;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("azure-blob");
    const provider = await createResourceProvider(keyConnection);
    expect(provider).toBeInstanceOf(AzureBlobProvider);
    clearResourceProviderCache();
  });

  test("refuses a connection with no account of any spelling", () => {
    expect(() => new AzureBlobProvider({ ...keyConnection, endpoint: undefined })).toThrow(ResourceConfigError);
    expect(
      () =>
        new AzureBlobProvider({
          ...keyConnection,
          endpoint: undefined,
          accountKey: undefined,
          authMode: "workload-identity",
        }),
    ).toThrow(ResourceConfigError);
  });

  test("shared-key auth keeps the endpoint path and names the account", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(capturedServiceArgs[0]).toEqual({
      url: "http://127.0.0.1:10000/devstoreaccount1",
      credential: "shared-key:devstoreaccount1",
    });
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("shared-key auth reads the account out of a real account's subdomain", async () => {
    const provider = new AzureBlobProvider({
      ...keyConnection,
      endpoint: "https://myaccount.blob.core.windows.net",
    });
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://myaccount.blob.core.windows.net",
      credential: "shared-key:myaccount",
    });
  });

  test("Entra ID auth builds the account URL from the vault name", async () => {
    const provider = new AzureBlobProvider({
      ...aadConnection,
      endpoint: undefined,
      vaultName: "myaccount",
    });
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://myaccount.blob.core.windows.net",
      credential: "aad:tenant",
    });
  });

  test("connection-string auth hands the string to the SDK's own parser", async () => {
    const provider = new AzureBlobProvider(connectionStringConnection);
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://csaccount.blob.core.windows.net",
      credential: "sas-in-url",
    });
  });

  test("a malformed connection string is a config mistake that never echoes the key", async () => {
    const provider = new AzureBlobProvider({
      ...connectionStringConnection,
      connectionString: "not a connection string",
    });
    const error = await provider.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResourceConfigError);
    expect((error as Error).message).toContain("could not be parsed");
    expect((error as Error).message).not.toContain("a2V5");
  });

  test("account SAS carries the token in the service URL and lists containers", async () => {
    const provider = new AzureBlobProvider(sasAccountConnection);
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://myaccount.blob.core.windows.net/?sig=token",
      credential: "sas-in-url",
    });
    const page = await provider.listBuckets();
    expect(page.truncated).toBe(false);
    expect(page.nodes[0]).toMatchObject({ id: "container/fixture", kind: "container", name: "fixture" });
  });

  test("container SAS scopes the tree to the one container its token addresses", async () => {
    const provider = new AzureBlobProvider(sasContainerConnection);
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "http://127.0.0.1:10000/devstoreaccount1/?sig=token",
      credential: "sas-in-url",
    });
    // The scoped root never asks the service for a container listing.
    const page = await provider.listBuckets();
    expect(listContainersCalls).toBe(0);
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({ id: "container/fixture", name: "fixture", hasChildren: true });

    const level = await provider.listNodes("container/fixture");
    expect(level.nodes[0]).toMatchObject({ id: "container/fixture/nested/", kind: "prefix", name: "nested" });
  });

  test("a scoped connection refuses another container by name, not with an empty listing", async () => {
    const provider = new AzureBlobProvider(sasContainerConnection);
    const error = await provider.listObjects("other", null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as Error).message).toContain('scoped to container "fixture"');
  });

  test("workload identity is the default when no credential is present", async () => {
    const provider = new AzureBlobProvider({
      id: "res-6",
      name: "cluster",
      type: "azure-blob",
      createdAt: "2026-01-01T00:00:00.000Z",
      endpoint: "https://myaccount.blob.core.windows.net",
    });
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://myaccount.blob.core.windows.net",
      credential: "workload:env/env",
    });
  });

  test("workload identity passes the record's tenant and client hints through", async () => {
    const provider = new AzureBlobProvider({
      id: "res-7",
      name: "cluster-hinted",
      type: "azure-blob",
      createdAt: "2026-01-01T00:00:00.000Z",
      endpoint: "https://myaccount.blob.core.windows.net",
      tenantId: "tenant-7",
      clientId: "client-7",
    });
    await provider.connect();
    expect(capturedServiceArgs[0]).toEqual({
      url: "https://myaccount.blob.core.windows.net",
      credential: "workload:tenant-7/client-7",
    });
  });

  test("managed identity honours an explicit authMode and an optional client id", async () => {
    const systemAssigned = new AzureBlobProvider({
      id: "res-8",
      name: "mi-system",
      type: "azure-blob",
      createdAt: "2026-01-01T00:00:00.000Z",
      vaultName: "myaccount",
      authMode: "managed-identity",
    });
    await systemAssigned.connect();
    expect(capturedServiceArgs[0]).toMatchObject({ credential: "managed:system" });

    capturedServiceArgs.length = 0;
    const userAssigned = new AzureBlobProvider({
      id: "res-9",
      name: "mi-user",
      type: "azure-blob",
      createdAt: "2026-01-01T00:00:00.000Z",
      vaultName: "myaccount",
      authMode: "managed-identity",
      clientId: "identity-client",
    });
    await userAssigned.connect();
    expect(capturedServiceArgs[0]).toMatchObject({ credential: "managed:identity-client" });
  });

  test("disconnect clears and health answers through the root read", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect((await provider.getHealth()).status).toBe("healthy");
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
  });

  test("health of a scoped connection probes the scoped container, not a listing", async () => {
    const provider = new AzureBlobProvider(sasContainerConnection);
    expect((await provider.getHealth()).status).toBe("healthy");
    expect(listContainersCalls).toBe(0);
  });

  test("connect of a scoped connection whose container is gone is a missing-resource refusal", async () => {
    const provider = new AzureBlobProvider({
      ...sasContainerConnection,
      sasUrl: "http://127.0.0.1:10000/devstoreaccount1/gone?sig=token",
    });
    const error = await provider.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as Error).message).toContain('Container "gone" does not exist');
  });

  test("upload to a missing container is a 404", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const error = await provider.uploadBlob("no-container", "x.txt", toStream("x")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("previews images and binaries by kind, and guards bodiless downloads", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const image = await provider.previewBlob("fixture", "photo.png", 64);
    expect(image).toMatchObject({ kind: "image", truncated: false, contentType: "image/png" });

    const binary = await provider.previewBlob("fixture", "blob.bin", 64);
    expect(binary.kind).toBe("binary");

    const bodiless = await provider.downloadBlob("fixture", "nobody.txt").catch((e: unknown) => e);
    expect(bodiless).toBeInstanceOf(ResourceConnectionError);
  });

  test("previews clamp the byte limit to the provider cap and report truncation", async () => {
    const provider = new AzureBlobProvider(keyConnection);

    const capped = await provider.previewBlob("fixture", "big.txt", 1_000_000);
    expect(capped).toMatchObject({ kind: "text", truncated: false });
    expect(capped.text).toBe("y".repeat(200));

    const short = await provider.previewBlob("fixture", "big.txt", 16);
    expect(short.truncated).toBe(true);
    expect(short.text).toBe("y".repeat(16));

    const minimum = await provider.previewBlob("fixture", "hello.txt", 0);
    expect(minimum.text).toBe("h");
  });

  test("lists containers as root nodes with a measured truncation flag", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const page = await provider.listNodes(null);
    expect(page.truncated).toBe(false);
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({
      id: "container/fixture",
      parentId: null,
      kind: "container",
      name: "fixture",
      hasChildren: true,
    });
    expect(listContainersCalls).toBe(1);
  });

  test("lists a level with prefixes, ids round-trip", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    expect(splitNodeId("container/fixture")).toEqual({ bucket: "fixture", prefix: null });

    const level = await provider.listNodes("container/fixture");
    expect(level.nodes).toHaveLength(1);
    expect(level.nodes[0]).toMatchObject({ id: "container/fixture/nested/", kind: "prefix", name: "nested" });
    expect(splitNodeId(level.nodes[0].id)).toEqual({ bucket: "fixture", prefix: "nested/" });
  });

  test("a missing container is a 404, not an empty listing", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const error = await provider.listNodes("container/no-container").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("reads meta, downloads bytes and previews text", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const meta = await provider.readBlobMeta("fixture", "hello.txt");
    expect(meta).toMatchObject({ name: "hello.txt", sizeBytes: 18, contentType: "application/octet-stream" });

    const download = await provider.downloadBlob("fixture", "hello.txt");
    expect(await new Response(download.body).text()).toBe("hello storagebase\n");

    const preview = await provider.previewBlob("fixture", "hello.txt", 64);
    expect(preview).toMatchObject({ kind: "text", text: "hello storagebase\n", truncated: false });
  });

  test("a missing blob is a 404 on read, download and preview", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    for (const call of [
      () => provider.readBlobMeta("fixture", "nope.txt"),
      () => provider.downloadBlob("fixture", "nope.txt"),
      () => provider.previewBlob("fixture", "nope.txt", 64),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceNotFoundError);
    }
  });

  test("upload streams in blocks and returns fresh meta", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const meta = await provider.uploadBlob("fixture", "hello.txt", toStream("hello storagebase\n"));
    expect(meta.name).toBe("hello.txt");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatchObject({
      container: "fixture",
      name: "hello.txt",
      bytes: "hello storagebase\n",
      bufferSize: AZURE_BLOB_UPLOAD_BLOCK_SIZE,
      maxConcurrency: AZURE_BLOB_UPLOAD_CONCURRENCY,
    });
    expect(AZURE_BLOB_UPLOAD_BLOCK_SIZE).toBe(4 * 1024 * 1024);
    expect(AZURE_BLOB_UPLOAD_CONCURRENCY).toBe(5);
  });

  test("an upload stream that fails mid-read surfaces as a connection error", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const error = await provider.uploadBlob("fixture", "broken.txt", toFailingStream()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(uploaded[0]?.streamError).toBe(true);
  });

  test("delete removes an existing blob, and a missing one is a 404", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    await provider.deleteBlob("fixture", "hello.txt");
    expect(deleted).toEqual([{ container: "fixture", name: "hello.txt" }]);

    const error = await provider.deleteBlob("fixture", "nope.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("a download stream can be cancelled mid-read", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const download = await provider.downloadBlob("fixture", "hello.txt");
    await download.body.cancel();
    expect(provider).toBeInstanceOf(AzureBlobProvider);
  });

  test("capabilities and labels are type-driven, no socket needed", () => {
    const provider = new AzureBlobProvider(keyConnection);
    expect(provider.getCapabilities()).toMatchObject({ category: "blob", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toContain("blob.upload");
    expect(provider.getLabels()).toEqual({ containerNoun: "Containers", itemNoun: "Blobs" });
    // The caps the doc page names, pinned where the behaviour lives.
    expect(AZURE_BLOB_LIST_LIMIT).toBe(1000);
    expect(AZURE_BLOB_PREVIEW_LIMIT).toBe(64 * 1024);
  });

  test("a service refusal surfaces as a connection error", async () => {
    const provider = new AzureBlobProvider({ ...keyConnection, endpoint: "http://localhost:1/devstoreaccount1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("describe() carries ids only — no credential field rides along", () => {
    // An explicit authMode also documents that extra credential fields are
    // ignored, not merged: this record carries a stray key beside its SAS URL.
    const provider = new AzureBlobProvider({ ...sasAccountConnection, accountKey: "hush", authMode: "sas-url" });
    expect(provider.describe()).toEqual({ id: "res-3", name: "sas-account", type: "azure-blob" });
  });
});
