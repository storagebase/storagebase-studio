import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * S3 provider tests. The SDK is doubled with mock.module; every answer below
 * is shaped from a live pass against MinIO (see docs/resources/compose.md),
 * recorded 2026-09-20:
 * - ListObjects roots answer Contents + CommonPrefixes together; nested
 *   levels answer prefixes only. IsTruncated is the service's own flag.
 * - A missing key on HeadObject answers 404 with message "UnknownError" and
 *   NO Code — the provider must read the status, not the code.
 * - A missing bucket on ListObjectsV2 answers Code NoSuchBucket + 404.
 * - DeleteObject on a missing key answers 204: the provider checks existence
 *   first so a missing object is a 404, not silence.
 */

function fakeCommand(name: string, input: unknown) {
  return { commandName: name, input };
}

class FakeListBucketsCommand {
  readonly commandName = "ListBucketsCommand";
  constructor(public readonly input: unknown) {}
}
class FakeListObjectsV2Command {
  readonly commandName = "ListObjectsV2Command";
  constructor(public readonly input: unknown) {}
}
class FakeHeadObjectCommand {
  readonly commandName = "HeadObjectCommand";
  constructor(public readonly input: unknown) {}
}
class FakeGetObjectCommand {
  readonly commandName = "GetObjectCommand";
  constructor(public readonly input: unknown) {}
}
class FakePutObjectCommand {
  readonly commandName = "PutObjectCommand";
  constructor(public readonly input: unknown) {}
}
class FakeDeleteObjectCommand {
  readonly commandName = "DeleteObjectCommand";
  constructor(public readonly input: unknown) {}
}

interface SentCall {
  command: string;
  input: unknown;
}

const sentCalls: SentCall[] = [];

/** Live-shaped answers, keyed to look like the MinIO responses above. */
const FIXTURE = {
  buckets: [{ Name: "fixture-blobs", CreationDate: new Date("2026-09-19T21:40:48.088Z") }],
  roots: {
    Contents: [{ Key: "hello.txt", LastModified: new Date("2026-09-19T21:40:48.101Z"), Size: 18 }],
    CommonPrefixes: [{ Prefix: "nested/" }],
    IsTruncated: false,
  },
  nested: {
    Contents: [],
    CommonPrefixes: [{ Prefix: "nested/dir/" }],
    IsTruncated: false,
  },
};

function s3Error(code: string | undefined, status: number, message: string) {
  const error = new Error(message) as Error & { Code?: string; $metadata: { httpStatusCode: number } };
  if (code !== undefined) error.Code = code;
  error.$metadata = { httpStatusCode: status };
  return error;
}

function toStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * A node-style async-iterable body — what the SDK actually answers in this
 * runtime. The provider must convert it to the contract's web stream rather
 * than passing it through (a web ReadableStream would fail this shape check
 * loudly in the wrong direction: silently handing the caller an unreadable).
 */
function nodeStyleBody(text: string): unknown {
  return nodeStyleBytes(new TextEncoder().encode(text));
}

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

class FakeS3Client {
  static lastConfig: unknown = null;
  destroyed = false;
  private readonly config: { endpoint?: string };
  constructor(config: { endpoint?: string }) {
    FakeS3Client.lastConfig = config;
    this.config = config;
  }
  destroy() {
    this.destroyed = true;
  }
  async send(command: { commandName: string; input: Record<string, unknown> }): Promise<unknown> {
    if (this.config.endpoint === "http://localhost:1") throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    sentCalls.push({ command: command.commandName, input: command.input });
    switch (command.commandName) {
      case "ListBucketsCommand":
        return { Buckets: FIXTURE.buckets };
      case "ListObjectsV2Command": {
        const { Bucket, Prefix, Delimiter, MaxKeys } = command.input;
        if (Bucket !== "fixture-blobs") throw s3Error("NoSuchBucket", 404, "The specified bucket does not exist");
        expect(Delimiter).toBe("/");
        expect(MaxKeys).toBe(1000);
        return Prefix === "nested/" ? FIXTURE.nested : FIXTURE.roots;
      }
      case "HeadObjectCommand":
        if (command.input.Key !== "hello.txt") throw s3Error(undefined, 404, "UnknownError");
        return { ContentLength: 18, LastModified: new Date("2026-09-19T21:40:48.000Z"), ContentType: "text/plain" };
      case "GetObjectCommand": {
        if (
          command.input.Key !== "hello.txt" &&
          command.input.Key !== "photo.png" &&
          command.input.Key !== "blob.bin" &&
          command.input.Key !== "long.txt"
        ) {
          throw s3Error("NoSuchKey", 404, "The specified key does not exist");
        }
        if (command.input.Key === "photo.png") {
          return { Body: nodeStyleBody("PNGDATA"), ContentType: "image/png", ContentLength: 7 };
        }
        if (command.input.Key === "blob.bin") {
          // Raw invalid UTF-8: TextEncoder would launder these into valid
          // output, so the bytes are built directly to prove binary detection.
          return {
            Body: nodeStyleBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x41])),
            ContentType: "application/octet-stream",
            ContentLength: 4,
          };
        }
        if (command.input.Key === "long.txt") {
          return { Body: nodeStyleBody("x".repeat(100)), ContentType: "text/plain", ContentLength: 100 };
        }
        return { Body: nodeStyleBody("hello storagebase\n"), ContentType: "text/plain", ContentLength: 18 };
      }
      case "PutObjectCommand":
        return {};
      case "DeleteObjectCommand":
        return {};
      default:
        throw new Error(`unexpected command ${command.commandName}`);
    }
  }
}

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: FakeS3Client,
  ListBucketsCommand: FakeListBucketsCommand,
  ListObjectsV2Command: FakeListObjectsV2Command,
  HeadObjectCommand: FakeHeadObjectCommand,
  GetObjectCommand: FakeGetObjectCommand,
  PutObjectCommand: FakePutObjectCommand,
  DeleteObjectCommand: FakeDeleteObjectCommand,
}));

// Importing the module self-registers the s3 loader, like production.
const { S3Provider, splitNodeId } = await import("@/lib/resources/providers/blob/s3");

const connection: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
};

describe("S3Provider", () => {
  beforeEach(() => {
    sentCalls.length = 0;
    FakeS3Client.lastConfig = null;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("s3");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(S3Provider);
  });

  test("refuses a connection with neither region nor endpoint", () => {
    expect(() => new S3Provider({ ...connection, region: undefined })).toThrow(ResourceConfigError);
  });

  test("connect probes and disconnect destroys the client", async () => {
    const provider = new S3Provider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    // A double disconnect stays silent.
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("health answers through the bucket listing", async () => {
    const provider = new S3Provider(connection);
    const health = await provider.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.latencyMs).toBeDefined();
  });

  test("an unreachable endpoint fails connect as unreachable, not degraded", async () => {
    const provider = new S3Provider({ ...connection, endpoint: "http://localhost:1" });
    const error = await provider.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect(provider.isConnected()).toBe(false);
    // …and the endpoint override forces path style for S3-compatibles.
    const probe = new S3Provider({ ...connection, endpoint: "http://localhost:1" });
    await probe.connect().catch(() => undefined);
    const config = FakeS3Client.lastConfig as { endpoint: string; forcePathStyle: boolean };
    expect(config.endpoint).toBe("http://localhost:1");
    expect(config.forcePathStyle).toBe(true);
  });

  test("lists buckets as root nodes", async () => {
    const provider = new S3Provider(connection);
    const page = await provider.listNodes(null);
    expect(page.truncated).toBe(false);
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({
      id: "bucket/fixture-blobs",
      parentId: null,
      kind: "bucket",
      name: "fixture-blobs",
      hasChildren: true,
    });
  });

  test("lists a level with prefixes and objects, ids round-trip", async () => {
    const provider = new S3Provider(connection);
    const roots = await provider.listNodes(null);
    expect(roots.nodes).toHaveLength(1);

    // Roots carry no prefix: split the bucket id back.
    expect(splitNodeId("bucket/fixture-blobs")).toEqual({ bucket: "fixture-blobs", prefix: null });

    const level = await provider.listNodes("bucket/fixture-blobs");
    expect(level.nodes).toHaveLength(2);
    const [prefix, object] = level.nodes;
    expect(prefix).toMatchObject({ id: "bucket/fixture-blobs/nested/", kind: "prefix", name: "nested" });
    expect(object).toMatchObject({ id: "bucket/fixture-blobs/hello.txt", kind: "object", name: "hello.txt" });
    expect(object.meta).toMatchObject({ size: 18 });

    // The nested level's own id splits back to the Prefix it listed.
    expect(splitNodeId(prefix.id)).toEqual({ bucket: "fixture-blobs", prefix: "nested/" });
    const nested = await provider.listNodes(prefix.id);
    expect(nested.nodes).toHaveLength(1);
    expect(nested.nodes[0].id).toBe("bucket/fixture-blobs/nested/dir/");
  });

  test("a missing bucket is a 404, not an empty listing", async () => {
    const provider = new S3Provider(connection);
    const error = await provider.listNodes("bucket/no-bucket").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("reads meta, downloads bytes and previews text", async () => {
    const provider = new S3Provider(connection);
    const meta = await provider.readBlobMeta("fixture-blobs", "hello.txt");
    expect(meta).toMatchObject({ name: "hello.txt", sizeBytes: 18, contentType: "text/plain" });

    const download = await provider.downloadBlob("fixture-blobs", "hello.txt");
    expect(download.contentType).toBe("text/plain");
    expect(await new Response(download.body).text()).toBe("hello storagebase\n");

    const preview = await provider.previewBlob("fixture-blobs", "hello.txt", 64);
    expect(preview).toMatchObject({ kind: "text", text: "hello storagebase\n", truncated: false });
  });

  test("a missing object is a 404 on read, download and preview", async () => {
    const provider = new S3Provider(connection);
    for (const call of [
      () => provider.readBlobMeta("fixture-blobs", "nope.txt"),
      () => provider.downloadBlob("fixture-blobs", "nope.txt"),
      () => provider.previewBlob("fixture-blobs", "nope.txt", 64),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceNotFoundError);
    }
  });

  test("previews images, binaries and truncated bodies by kind", async () => {
    const provider = new S3Provider(connection);
    const image = await provider.previewBlob("fixture-blobs", "photo.png", 64);
    expect(image).toMatchObject({ kind: "image", truncated: false, contentType: "image/png" });
    expect(image.text).toBeUndefined();

    const binary = await provider.previewBlob("fixture-blobs", "blob.bin", 64);
    expect(binary.kind).toBe("binary");

    const long = await provider.previewBlob("fixture-blobs", "long.txt", 10);
    expect(long).toMatchObject({ kind: "text", truncated: true });
    expect(long.text).toHaveLength(10);
  });

  test("a download stream can be cancelled mid-read", async () => {
    const provider = new S3Provider(connection);
    const download = await provider.downloadBlob("fixture-blobs", "hello.txt");
    // Cancelling drives the converter's cancel arm (iterator teardown),
    // which a full read never reaches.
    await download.body.cancel();
    expect(provider).toBeInstanceOf(S3Provider);
  });

  test("upload to a missing bucket is a 404", async () => {
    const provider = new S3Provider(connection);
    const error = await provider.uploadBlob("no-bucket", "x.txt", toStream("x")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("upload returns fresh meta and delete removes an existing object", async () => {
    const provider = new S3Provider(connection);
    const meta = await provider.uploadBlob("fixture-blobs", "hello.txt", toStream("hello storagebase\n"));
    expect(meta.name).toBe("hello.txt");
    expect(sentCalls.some((c) => c.command === "PutObjectCommand")).toBe(true);

    await provider.deleteBlob("fixture-blobs", "hello.txt");
    expect(sentCalls.some((c) => c.command === "DeleteObjectCommand")).toBe(true);
  });

  test("deleting a missing object is a 404, not silent idempotency", async () => {
    const provider = new S3Provider(connection);
    const error = await provider.deleteBlob("fixture-blobs", "nope.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("capabilities and labels are type-driven, no socket needed", () => {
    const provider = new S3Provider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "blob", defaultPort: 443 });
    expect(provider.getCapabilities().operations).toContain("blob.delete");
    expect(provider.getLabels()).toEqual({ containerNoun: "Buckets", itemNoun: "Objects" });
  });

  test("a failing client surfaces its status code", async () => {
    const provider = new S3Provider(connection);
    const error = await provider.listNodes("bucket/no-bucket").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect((error as { statusCode: number }).statusCode).toBe(404);
  });
});
