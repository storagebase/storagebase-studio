import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";

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

const mockUploadBlob = mock(async (_bucket: string, _name: string) => ({
  id: "bucket/fixture-blobs/new.txt",
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
  getLabels: () => ({ containerNoun: "Buckets", itemNoun: "Objects" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  uploadBlob: mockUploadBlob,
  deleteBlob: mockDeleteBlob,
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

const { POST: postUpload } = await import("@/app/api/resources/blob/upload/route");
const { POST: postDelete } = await import("@/app/api/resources/blob/delete/route");

const connection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

function auditEvents() {
  return mockEmitAuditEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe("blob write routes", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateResourceProvider.mockClear();
    mockGetOrCreateResourceProvider.mockImplementation(async () => fakeBlob);
    mockUploadBlob.mockClear();
    mockDeleteBlob.mockClear();
  });

  test("upload writes and records decision + outcome with one correlation id", async () => {
    const contentBase64 = Buffer.from("hello").toString("base64");
    const req = createMockRequest("/api/resources/blob/upload", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "new.txt", contentBase64 },
    });
    const res = await postUpload(req as never);
    const data = await parseResponseJSON<{ name: string }>(res);
    expect(res.status).toBe(200);
    expect(data.name).toBe("new.txt");
    expect(mockUploadBlob).toHaveBeenCalledTimes(1);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "resource_operation",
      action: "blob.upload",
      target: "s3:fixture-blobs/new.txt",
      user: "admin",
      result: "success",
    });
    expect(events[1]).toMatchObject({ type: "resource_operation", action: "blob.upload", result: "success" });
    // Decision and outcome join on one id; the outcome carries no reason on success.
    expect(events[0].correlationId).toBeDefined();
    expect(events[1].correlationId).toBe(events[0].correlationId);
    expect(events[1]).not.toHaveProperty("reason");
  });

  test("upload without content or address is a 400 with no audit", async () => {
    for (const body of [
      { connection, bucket: "fixture-blobs", name: "new.txt" },
      { connection, bucket: "fixture-blobs", name: "new.txt", contentBase64: "" },
      { connection, bucket: "", name: "new.txt", contentBase64: "aGVsbG8=" },
    ]) {
      const req = createMockRequest("/api/resources/blob/upload", { method: "POST", body });
      expect((await postUpload(req as never)).status).toBe(400);
    }
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
    expect(mockUploadBlob).not.toHaveBeenCalled();
  });

  test("upload past the size cap is a 413", async () => {
    // Build the refusal from the limit itself rather than a 10MB literal —
    // the cap is what is under test, not base64 plumbing.
    const { BLOB_UPLOAD_LIMIT } = await import("@/app/api/resources/blob/upload/route");
    const oversized = Buffer.alloc(BLOB_UPLOAD_LIMIT + 1).toString("base64");
    const req = createMockRequest("/api/resources/blob/upload", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "big.bin", contentBase64: oversized },
    });
    const res = await postUpload(req as never);
    expect(res.status).toBe(413);
    expect(mockUploadBlob).not.toHaveBeenCalled();
  });

  test("delete removes and records decision + outcome", async () => {
    const req = createMockRequest("/api/resources/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    const data = await parseResponseJSON<{ deleted: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(true);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "blob.delete", result: "success" });
    expect(events[1]).toMatchObject({ action: "blob.delete", result: "success" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("a missing object on delete is a 404 with resource_not_found in the outcome", async () => {
    mockDeleteBlob.mockRejectedValueOnce(new ResourceNotFoundError('Object "gone.txt" does not exist'));
    const req = createMockRequest("/api/resources/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "gone.txt" },
    });
    const res = await postDelete(req as never);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(res.status).toBe(404);
    expect(data.code).toBe("RESOURCE_NOT_FOUND");

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "blob.delete", result: "success" });
    expect(events[1]).toMatchObject({ action: "blob.delete", result: "failure", reason: "resource_not_found" });
    expect(events[1].correlationId).toBe(events[0].correlationId);
  });

  test("a provider failure on delete is a 502 with resource_failed in the outcome", async () => {
    // Providers wrap service refusals in ResourceConnectionError (502); a bare
    // Error would be a 500, which is the mapper's shape for bugs, not refusals.
    mockDeleteBlob.mockRejectedValueOnce(new ResourceConnectionError("socket reset"));
    const req = createMockRequest("/api/resources/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(502);
    const events = auditEvents();
    expect(events[1]).toMatchObject({ result: "failure", reason: "resource_failed" });
  });

  test("a broken audit sink cannot turn a write into a 500", async () => {
    mockEmitAuditEvent.mockImplementationOnce(() => {
      throw new Error("ring buffer full");
    });
    const req = createMockRequest("/api/resources/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(200);
    expect(mockDeleteBlob).toHaveBeenCalledTimes(1);
  });

  test("writes require a session and parse no body without one", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = createMockRequest("/api/resources/blob/delete", {
      method: "POST",
      body: { connection, bucket: "fixture-blobs", name: "old.txt" },
    });
    const res = await postDelete(req as never);
    expect(res.status).toBe(401);
    expect(mockDeleteBlob).not.toHaveBeenCalled();
    // The 401 itself may audit through the guard; what must not exist is any
    // resource_operation event for a write that never ran.
    const writes = mockEmitAuditEvent.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).type === "resource_operation",
    );
    expect(writes).toHaveLength(0);
  });
});
