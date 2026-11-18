import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceConnectionError, ResourceNotFoundError } from "@/storagebase/resources/errors";
import {
  breakResourceAuditSinkOnce,
  installResourceRouteDoubles,
  mockGetOrCreateResourceProvider,
  mockGetSession,
  type RouteDoubles,
} from "../../unit/blob/route-doubles";

/**
 * Blob write route tests (fork port of the legacy `blob-writes.test.ts`,
 * moved by path, with the upload half rewritten for streaming: the body is
 * multipart/form-data — one `file` part plus the addressing fields and the
 * inline `connection` (stringified, the pre-save candidate path) — and the
 * route hands the FILE's stream to the provider, never a base64 string. The
 * REAL request chain runs; only the session, the audit recorders and the
 * provider are doubled (route-doubles.ts). The decision/outcome audit pair
 * keeps the legacy shape: one correlation id joining begin and end, the
 * target the object's address, never its bytes.
 */

/** Build the upload route's multipart request the way the viewer does. */
function createUploadRequest(fields: { bucket: string; name: string; file?: File; connection?: unknown }): Request {
  const form = new FormData();
  form.set("connection", JSON.stringify(fields.connection ?? connection));
  form.set("bucket", fields.bucket);
  form.set("name", fields.name);
  if (fields.file !== undefined) form.set("file", fields.file);
  return new Request("http://localhost:3000/api/sb/blob/upload", { method: "POST", body: form });
}

const connection = {
  id: "res-1",
  name: "backups",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
};

const mockUploadBlob = mock(async (_bucket: string, _name: string) => ({
  id: "container/fixture-blobs/new.txt",
  name: "new.txt",
  sizeBytes: 5,
  lastModified: null,
  contentType: null,
}));
const mockDeleteBlob = mock(async () => undefined);

const fakeBlob = {
  listBuckets: async () => ({ nodes: [], truncated: false }),
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
  uploadBlob: mockUploadBlob,
  deleteBlob: mockDeleteBlob,
};

const doubles: RouteDoubles = await installResourceRouteDoubles();

const { POST: postUpload, BLOB_UPLOAD_LIMIT } = await import("@/app/api/sb/blob/upload/route");
const { POST: postDelete } = await import("@/app/api/sb/blob/delete/route");

describe("blob write routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    doubles.resetRouteDoubles();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeBlob);
    mockUploadBlob.mockClear();
    mockDeleteBlob.mockClear();
  });

  test("upload streams the file part and records decision + outcome with one correlation id", async () => {
    const req = createUploadRequest({
      bucket: "fixture-blobs",
      name: "new.txt",
      file: new File(["hello"], "new.txt", { type: "text/plain" }),
    });
    const res = await postUpload(req as never);
    const data = await parseResponseJSON<{ name: string }>(res);
    expect(res.status).toBe(200);
    expect(data.name).toBe("new.txt");
    expect(mockUploadBlob).toHaveBeenCalledTimes(1);

    // The provider received the FILE's stream, and it carried the bytes.
    const [bucket, name, body] = mockUploadBlob.mock.calls[0] as unknown as [
      string,
      string,
      ReadableStream<Uint8Array>,
    ];
    expect(bucket).toBe("fixture-blobs");
    expect(name).toBe("new.txt");
    expect(await new Response(body).text()).toBe("hello");

    const records = doubles.writes;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "decision",
      action: "blob.upload",
      target: "azure-blob:fixture-blobs/new.txt",
      user: "admin",
    });
    expect(records[1]).toMatchObject({ kind: "outcome", action: "blob.upload", error: null });
    // Decision and outcome join on one id; the outcome carries no error on success.
    expect(records[0].correlationId).toBeDefined();
    expect(records[1].correlationId).toBe(records[0].correlationId);
  });

  test("a connection form field that is not JSON stays raw and the shared validation refuses it", async () => {
    const form = new FormData();
    form.set("connection", "{not json");
    form.set("bucket", "fixture-blobs");
    form.set("name", "new.txt");
    form.set("file", new File(["hello"], "new.txt"));
    const req = new Request("http://localhost:3000/api/sb/blob/upload", { method: "POST", body: form });
    const res = await postUpload(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);
    expect(res.status).toBe(400);
    expect(data.error).toContain("resource connection");
    expect(mockUploadBlob).not.toHaveBeenCalled();
  });

  test("a JSON body on the multipart route is a 400 with no audit", async () => {
    const req = createMockRequest("/api/sb/blob/upload", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "new.txt", contentBase64: "aGVsbG8=" },
    });
    const res = await postUpload(req as never);
    expect(res.status).toBe(400);
    expect(doubles.writes).toHaveLength(0);
    expect(mockUploadBlob).not.toHaveBeenCalled();
  });

  test("upload without a file part or an address is a 400 with no audit", async () => {
    for (const fields of [
      { bucket: "fixture-blobs", name: "new.txt" },
      { bucket: "", name: "new.txt", file: new File(["x"], "f.txt") },
      { bucket: "fixture-blobs", name: "", file: new File(["x"], "f.txt") },
      { bucket: "fixture-blobs", name: "new.txt", file: "not-a-file" as unknown as File },
    ]) {
      const req = createUploadRequest(fields);
      const res = await postUpload(req as never);
      expect(res.status).toBe(400);
    }
    expect(doubles.writes).toHaveLength(0);
    expect(mockUploadBlob).not.toHaveBeenCalled();
  });

  test("upload past the size cap is a 413 that never opens the stream", async () => {
    // Build the refusal from the limit itself rather than a byte literal — the
    // cap is what is under test, not form plumbing.
    const oversized = new File([new Uint8Array(BLOB_UPLOAD_LIMIT + 1)], "big.bin");
    expect(oversized.size).toBe(BLOB_UPLOAD_LIMIT + 1);
    const req = createUploadRequest({ bucket: "fixture-blobs", name: "big.bin", file: oversized });
    const res = await postUpload(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);
    expect(res.status).toBe(413);
    expect(data.error).toContain("this route accepts at most");
    expect(mockUploadBlob).not.toHaveBeenCalled();
    expect(doubles.writes).toHaveLength(0);
  });

  test("a provider failure on upload is a 502 with the failure in the outcome", async () => {
    mockUploadBlob.mockRejectedValueOnce(new ResourceConnectionError("socket reset"));
    const req = createUploadRequest({ bucket: "fixture-blobs", name: "new.txt", file: new File(["hello"], "new.txt") });
    const res = await postUpload(req as never);
    expect(res.status).toBe(502);
    const records = doubles.writes;
    expect(records[1]).toMatchObject({ kind: "outcome", action: "blob.upload" });
    expect((records[1].error as Error).message).toContain("socket reset");
  });

  test("delete removes and records decision + outcome", async () => {
    const req = createMockRequest("/api/sb/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    const data = await parseResponseJSON<{ deleted: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(true);

    const records = doubles.writes;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "decision", action: "blob.delete", user: "admin" });
    expect(records[1]).toMatchObject({ kind: "outcome", action: "blob.delete", error: null });
    expect(records[1].correlationId).toBe(records[0].correlationId);
  });

  test("a missing object on delete is a 404 with the failure in the outcome", async () => {
    mockDeleteBlob.mockRejectedValueOnce(new ResourceNotFoundError('Blob "gone.txt" does not exist'));
    const req = createMockRequest("/api/sb/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "gone.txt" },
    });
    const res = await postDelete(req as never);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(res.status).toBe(404);
    expect(data.code).toBe("SB_RESOURCE_NOT_FOUND");

    const records = doubles.writes;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: "decision", action: "blob.delete" });
    expect(records[1]).toMatchObject({ kind: "outcome", action: "blob.delete" });
    expect(records[1].correlationId).toBe(records[0].correlationId);
    expect((records[1].error as Error).message).toContain("gone.txt");
  });

  test("a provider failure on delete is a 502 with the failure in the outcome", async () => {
    // Providers wrap service refusals in ResourceConnectionError (502); a bare
    // Error would be a 500, which is the mapper's shape for bugs, not refusals.
    mockDeleteBlob.mockRejectedValueOnce(new ResourceConnectionError("socket reset"));
    const req = createMockRequest("/api/sb/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(502);
    expect((doubles.writes[1].error as Error).message).toContain("socket reset");
  });

  test("a broken audit sink cannot turn a write into a 500", async () => {
    breakResourceAuditSinkOnce();
    const req = createMockRequest("/api/sb/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(200);
    expect(mockDeleteBlob).toHaveBeenCalledTimes(1);
  });

  test("writes require a session and parse no body without one", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/sb/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(401);
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    // No resource_operation decision exists for a write that never ran.
    expect(doubles.writes).toHaveLength(0);
  });

  test("an unauthenticated upload never parses the form on the caller's behalf", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createUploadRequest({ bucket: "fixture-blobs", name: "new.txt", file: new File(["hello"], "new.txt") });
    const res = await postUpload(req as never);
    expect(res.status).toBe(401);
    expect(mockUploadBlob).not.toHaveBeenCalled();
    expect(doubles.writes).toHaveLength(0);
  });
});
