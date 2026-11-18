import { describe, test, expect, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceNotFoundError } from "@/storagebase/resources/errors";
import {
  installResourceRouteDoubles,
  mockGetOrCreateResourceProvider,
  mockGetSession,
  type RouteDoubles,
} from "../../unit/blob/route-doubles";

/**
 * Blob read route tests (fork port of the legacy `blob-reads.test.ts`,
 * moved by path). The REAL request chain runs — upstream `guardRoute` behind
 * the real `handleResourceRequest` (guard → parse → resolve → run), the real
 * SB_* error mapping — with the session, the audit recorders and the provider
 * doubled (see route-doubles.ts), so the guard-before-parse property stays a
 * measured fact. Connections travel inline (the pre-save candidate path the
 * fork serves without a store).
 */

const fakeBlob = {
  listBuckets: async () => ({ nodes: [], truncated: false }),
  listObjects: async () => ({ nodes: [], truncated: false }),
  readBlobMeta: async (bucket: string, name: string) => ({
    id: `container/${bucket}/${name}`,
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
    id: `container/${bucket}/${name}`,
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
  getLabels: () => ({ containerNoun: "Containers", itemNoun: "Blobs" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

const doubles: RouteDoubles = await installResourceRouteDoubles();

const { POST: postMeta } = await import("@/app/api/sb/blob/meta/route");
const { POST: postDownload } = await import("@/app/api/sb/blob/download/route");
const { POST: postPreview } = await import("@/app/api/sb/blob/preview/route");

const connection = {
  id: "res-1",
  name: "backups",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
};

describe("blob read routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    doubles.resetRouteDoubles();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeBlob);
  });

  test("meta answers the provider's metadata and audits one blob.meta read", async () => {
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ name: string; sizeBytes: number }>(res);
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ name: "hello.txt", sizeBytes: 18 });
    expect(doubles.reads).toHaveLength(1);
    expect(doubles.reads[0]).toMatchObject({
      action: "blob.meta",
      target: "azure-blob:fixture-blobs/hello.txt",
      result: "success",
      counts: { bytes: 18 },
    });
  });

  test("meta without bucket or name is a 400 with no audit", async () => {
    for (const body of [
      { connection, bucket: "", name: "hello.txt" },
      { connection, bucket: "fixture-blobs" },
      { connection, bucket: "fixture-blobs", name: 42 },
    ]) {
      const req = createMockRequest("/api/sb/blob/meta", { method: "POST", body });
      const res = await postMeta(req as never);
      expect(res.status).toBe(400);
    }
    expect(doubles.reads).toHaveLength(0);
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("a body with no connection at all is a 400, never a provider call", async () => {
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);
    expect(res.status).toBe(400);
    expect(data.error).toContain("resource connection");
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("a stored connection id with no fork store is an honest 503", async () => {
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { connectionId: "res_no-store", bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(res.status).toBe(503);
    expect(data.code).toBe("SB_STORE_UNAVAILABLE");
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
  });

  test("meta maps a missing object to 404 with the code", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeBlob,
      readBlobMeta: async () => {
        throw new ResourceNotFoundError('Blob "nope.txt" does not exist');
      },
    }));
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "nope.txt" },
    });
    const res = await postMeta(req as never);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(res.status).toBe(404);
    expect(data.code).toBe("SB_RESOURCE_NOT_FOUND");
    expect(doubles.reads[0]).toMatchObject({ result: "failure" });
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    mockGetOrCreateResourceProvider.mockImplementationOnce(async () => ({
      ...fakeBlob,
      getCapabilities: () => ({ ...fakeBlob.getCapabilities(), operations: ["tree"] }),
    }));
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("SB_RESOURCE_OPERATION_UNSUPPORTED");
  });

  test("download streams bytes with content headers", async () => {
    const req = createMockRequest("/api/sb/blob/download", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postDownload(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe("18");
    expect(await res.text()).toBe("hello storagebase\n");
    expect(doubles.reads[0]).toMatchObject({ action: "blob.download", counts: { bytes: 18 } });
  });

  test("preview validates the byte limit and answers the provider's preview", async () => {
    const defaulted = createMockRequest("/api/sb/blob/preview", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const defaultRes = await postPreview(defaulted as never);
    expect(defaultRes.status).toBe(200);
    expect(doubles.reads[0]).toMatchObject({ counts: { byteLimit: 65536 } });

    const req = createMockRequest("/api/sb/blob/preview", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt", byteLimit: 64 },
    });
    const res = await postPreview(req as never);
    const data = await parseResponseJSON<{ kind: string }>(res);
    expect(res.status).toBe(200);
    expect(data.kind).toBe("text");
    expect(doubles.reads[1]).toMatchObject({
      action: "blob.preview",
      counts: { byteLimit: 64, truncated: false },
    });

    for (const byteLimit of [0, -1, 1.5, "64"]) {
      const bad = createMockRequest("/api/sb/blob/preview", {
        method: "POST",
        body: { connection, bucket: "fixture-blobs", name: "hello.txt", byteLimit },
      });
      expect((await postPreview(bad as never)).status).toBe(400);
    }
  });

  test("reads require a session and parse no body without one", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/blob/meta", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "hello.txt" },
    });
    const res = await postMeta(req as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(mockGetOrCreateResourceProvider).not.toHaveBeenCalled();
    expect(doubles.reads).toHaveLength(0);
  });
});
