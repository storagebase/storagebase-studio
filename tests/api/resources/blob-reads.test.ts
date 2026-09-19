import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceNotFoundError } from "@/lib/resources/errors";

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
}));

const fakeBlob = {
  listBuckets: async () => ({ nodes: [], truncated: false }),
  listObjects: async () => ({ nodes: [], truncated: false }),
  readBlobMeta: async (bucket: string, name: string) => ({
    id: `bucket/${bucket}/${name}`,
    name,
    sizeBytes: 18,
    lastModified: "2026-09-19T21:40:48.000Z",
    contentType: "text/plain",
  }),
  downloadBlob: async () => ({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello storagebase\n"));
        controller.close();
      },
    }),
    contentType: "text/plain",
    sizeBytes: 18,
  }),
  previewBlob: async () => ({ kind: "text", text: "hello storagebase\n", truncated: false, contentType: "text/plain" }),
  uploadBlob: async (bucket: string, name: string) => ({
    id: `bucket/${bucket}/${name}`,
    name,
    sizeBytes: 18,
    lastModified: null,
    contentType: null,
  }),
  deleteBlob: async () => undefined,
  getCapabilities: () => ({
    category: "blob",
    defaultPort: 443,
    supportsSshTunnel: false,
    operations: ["tree", "blob.read", "blob.download", "blob.upload", "blob.delete"],
  }),
  getLabels: () => ({ containerNoun: "Buckets", itemNoun: "Objects" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const mockGetOrCreateResourceProvider = mock(async () => fakeBlob);

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => fakeBlob),
  getOrCreateResourceProvider: mockGetOrCreateResourceProvider,
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { POST: postMeta } = await import("@/app/api/resources/blob/meta/route");
const { POST: postDownload } = await import("@/app/api/resources/blob/download/route");
const { POST: postPreview } = await import("@/app/api/resources/blob/preview/route");

const connection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

describe("blob read routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockEmitAuditEvent.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeBlob);
  });

  test("meta answers the provider's metadata and audits nothing", async () => {
    const req = createMockRequest("/api/resources/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ name: string; sizeBytes: number }>(res);
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ name: "hello.txt", sizeBytes: 18 });
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });

  test("meta without bucket or name is a 400", async () => {
    for (const body of [
      { connection, bucket: "", name: "hello.txt" },
      { connection, bucket: "fixture-blobs" },
      { connection, bucket: "fixture-blobs", name: 42 },
    ]) {
      const req = createMockRequest("/api/resources/blob/meta", { method: "POST", body });
      const res = await postMeta(req as never);
      expect(res.status).toBe(400);
    }
  });

  test("meta maps a missing object to 404 with the code", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeBlob,
      readBlobMeta: async () => {
        throw new ResourceNotFoundError('Object "nope.txt" does not exist');
      },
    }));
    const req = createMockRequest("/api/resources/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "nope.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(res.status).toBe(404);
    expect(data.code).toBe("RESOURCE_NOT_FOUND");
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeBlob,
      getCapabilities: () => ({ ...fakeBlob.getCapabilities(), operations: ["tree"] }),
    }));
    const req = createMockRequest("/api/resources/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("RESOURCE_OPERATION_UNSUPPORTED");
  });

  test("download streams bytes with content headers", async () => {
    const req = createMockRequest("/api/resources/blob/download", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postDownload(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe("18");
    expect(await res.text()).toBe("hello storagebase\n");
  });

  test("preview validates the byte limit and answers the provider's preview", async () => {
    const req = createMockRequest("/api/resources/blob/preview", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt", byteLimit: 64 },
    });
    const res = await postPreview(req as never);
    const data = await parseResponseJSON<{ kind: string }>(res);
    expect(res.status).toBe(200);
    expect(data.kind).toBe("text");

    const bad = createMockRequest("/api/resources/blob/preview", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt", byteLimit: 0 },
    });
    expect((await postPreview(bad as never)).status).toBe(400);
  });

  test("reads require a session and parse no body without one", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    expect(res.status).toBe(401);
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });
});
