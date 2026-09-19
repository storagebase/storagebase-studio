import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * Azure Blob provider tests. The SDKs are doubled with mock.module; every
 * answer below is shaped from a live pass against Azurite (see
 * docs/resources/compose.md), recorded 2026-09-20:
 * - Hierarchy levels answer `blobPrefixes` + `blobItems` together; kinds are
 *   "prefix"/"blob". The page carries `continuationToken: ""` when done —
 *   that marker (not a second request) is the truncation verdict, because
 *   Azurite rejects the empty-marker peek with "query parameters invalid".
 * - A missing blob on getProperties answers statusCode 404 with an EMPTY
 *   message and no code — the provider must read the status, not the text.
 * - `exists()` answers plain booleans; the provider pre-checks existence so
 *   a missing container/blob is a 404 with the provider's own sentence.
 */

function toStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
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

const capturedServiceArgs: Array<{ url: string; credential: string }> = [];
const uploaded: Array<{ container: string; name: string }> = [];
const deleted: Array<{ container: string; name: string }> = [];

class FakeCredential {
  constructor(public readonly kind: string) {}
}

class FakeBlobClient {
  constructor(
    private readonly container: string,
    private readonly name: string,
  ) {}
  async getProperties() {
    if (this.name !== "hello.txt") throw azureError(404, "");
    return {
      contentLength: 18,
      contentType: "application/octet-stream",
      lastModified: new Date("2026-09-20T00:41:02.000Z"),
    };
  }
  async download(offset?: number, count?: number) {
    if (this.name !== "hello.txt") throw azureError(404, "");
    // Full downloads pass no range; previews pass (0, limit+1). The count is
    // recorded so tests can tell the two apart.
    return {
      readableStreamBody: toStream("hello storagebase\n"),
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
  listBlobsByHierarchy(_delimiter: string, options?: { prefix?: string }) {
    const self = this;
    return {
      byPage(_settings?: { maxPageSize?: number }) {
        return {
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              async next() {
                if (done) return { done: true, value: undefined };
                done = true;
                if (self.name !== "fixture") throw azureError(404, "", "ContainerNotFound");
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
                      blobItems: prefix === "" ? [] : FIXTURE_BLOBS.slice(0, 0),
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
  }
  getBlobClient(name: string) {
    return new FakeBlobClient(this.name, name);
  }
  getBlockBlobClient(name: string) {
    const container = this.name;
    return {
      async uploadStream(_stream: unknown) {
        uploaded.push({ container, name });
      },
    };
  }
}

class FakeBlobServiceClient {
  constructor(
    private readonly url: string,
    credential: FakeCredential,
  ) {
    capturedServiceArgs.push({ url, credential: credential.kind });
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
}));

// Importing the module self-registers the azure-blob loader, like production.
const { AzureBlobProvider, splitNodeId } = await import("@/lib/resources/providers/blob/azure-blob");

const keyConnection: ResourceConnection = {
  id: "res-1",
  name: "azurite",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:10000/devstoreaccount1",
  accountKey: "devstorekey",
};

const aadConnection: ResourceConnection = {
  id: "res-2",
  name: "azure",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
};

describe("AzureBlobProvider", () => {
  beforeEach(() => {
    capturedServiceArgs.length = 0;
    uploaded.length = 0;
    deleted.length = 0;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("azure-blob");
    const provider = await createResourceProvider(keyConnection);
    expect(provider).toBeInstanceOf(AzureBlobProvider);
  });

  test("refuses a connection with no account and no credential set", () => {
    expect(() => new AzureBlobProvider({ ...keyConnection, endpoint: undefined })).toThrow(ResourceConfigError);
    expect(() => new AzureBlobProvider({ ...aadConnection, tenantId: undefined })).toThrow(ResourceConfigError);
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

  test("upload returns fresh meta and delete removes an existing blob", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const meta = await provider.uploadBlob("fixture", "hello.txt", toStream("hello storagebase\n"));
    expect(meta.name).toBe("hello.txt");
    expect(uploaded).toEqual([{ container: "fixture", name: "hello.txt" }]);

    await provider.deleteBlob("fixture", "hello.txt");
    expect(deleted).toEqual([{ container: "fixture", name: "hello.txt" }]);
  });

  test("deleting a missing blob is a 404", async () => {
    const provider = new AzureBlobProvider(keyConnection);
    const error = await provider.deleteBlob("fixture", "nope.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("capabilities and labels are type-driven, no socket needed", () => {
    const provider = new AzureBlobProvider(keyConnection);
    expect(provider.getCapabilities()).toMatchObject({ category: "blob", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toContain("blob.upload");
    expect(provider.getLabels()).toEqual({ containerNoun: "Containers", itemNoun: "Blobs" });
  });

  test("a service refusal surfaces as a connection error", async () => {
    const provider = new AzureBlobProvider({ ...keyConnection, endpoint: "http://localhost:1/devstoreaccount1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
  });
});
