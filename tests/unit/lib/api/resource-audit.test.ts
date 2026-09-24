import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { auditedResourceRead, beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";
import { ResourceRouteError } from "@/lib/api/resource-route";
import { logger } from "@/lib/logger";
import {
  ResourceInvalidRequestError,
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
  ResourceConnectionError,
} from "@/lib/resources/errors";

const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => ({ id: "audit-1" }));

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
}));

describe("resource audit helper", () => {
  beforeEach(() => {
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
  });

  test("maps errors to the closed reason set", () => {
    const cases = [
      [new ResourceOperationUnsupportedError("x"), "resource_unsupported"],
      [new ResourceNotFoundError("x"), "resource_not_found"],
      [new ResourceConflictError("x"), "resource_conflict"],
      [new ResourceConnectionError("x"), "resource_failed"],
      [new Error("x"), "resource_failed"],
    ] as const;
    for (const [error, reason] of cases) {
      mockEmitAuditEvent.mockClear();
      const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
      endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, error);
      const outcome = mockEmitAuditEvent.mock.calls[1][0] as Record<string, unknown>;
      expect(outcome).toMatchObject({ result: "failure", reason });
    }
  });

  test("decision and outcome join on one correlation id", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    expect(typeof correlationId).toBe("string");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null);

    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(2);
    const [decision, outcome] = mockEmitAuditEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(decision).toMatchObject({ type: "resource_operation", action: "blob.delete", result: "success" });
    expect(outcome).toMatchObject({ type: "resource_operation", action: "blob.delete", result: "success" });
    expect(outcome.correlationId).toBe(decision.correlationId);
    expect(outcome).not.toHaveProperty("reason");
  });

  test("a failed outcome carries the mapped reason", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, new ResourceNotFoundError("gone"));

    const outcome = mockEmitAuditEvent.mock.calls[1][0] as Record<string, unknown>;
    expect(outcome).toMatchObject({ result: "failure", reason: "resource_not_found" });
  });

  test("a broken sink on the outcome still resolves", () => {
    mockEmitAuditEvent.mockImplementationOnce(() => ({ id: "audit-1" }));
    mockEmitAuditEvent.mockImplementationOnce(() => {
      throw new Error("ring buffer full");
    });
    const correlationId = beginResourceWrite("admin", "message.purge", "kafka:t");
    expect(() => endResourceWrite("admin", "message.purge", "kafka:t", correlationId, null)).not.toThrow();
  });

  test("a caller that passes its request gets the address and user agent on both events", () => {
    const request = {
      headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "curl/8.7.1" }),
    };
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k", request);
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null, request);

    for (const call of mockEmitAuditEvent.mock.calls) {
      expect(call[0]).toMatchObject({
        ip: "203.0.113.7",
        forwardedFor: "203.0.113.7, 10.0.0.1",
        userAgent: "curl/8.7.1",
      });
    }
  });

  test("a caller that passes no request records no request context", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null);

    for (const call of mockEmitAuditEvent.mock.calls) {
      expect(call[0]).not.toHaveProperty("ip");
      expect(call[0]).not.toHaveProperty("userAgent");
    }
  });

  test("a broken sink on the decision still returns an id", () => {
    mockEmitAuditEvent.mockImplementationOnce(() => {
      throw new Error("ring buffer full");
    });
    const correlationId = beginResourceWrite("admin", "message.purge", "kafka:t");
    expect(typeof correlationId).toBe("string");
  });
});

describe("auditedResourceRead", () => {
  const ctx = {
    session: { role: "user", username: "alice" },
    route: "api/resources/tree",
    connection: { id: "res-1", name: "Blob store", type: "s3" as const },
  };
  const request = {
    headers: new Headers({ "x-forwarded-for": "203.0.113.5", "user-agent": "test-agent/1.0" }),
  } as never;

  beforeEach(() => {
    mockEmitAuditEvent.mockClear();
    mockEmitAuditEvent.mockImplementation((_event: Record<string, unknown>) => ({ id: "audit-1" }));
  });

  function onlyEvent(): Record<string, unknown> {
    expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
    return mockEmitAuditEvent.mock.calls[0]?.[0] ?? {};
  }

  test("a successful read returns the result and records one event with the caller, connection and counts", async () => {
    const result = await auditedResourceRead(
      ctx,
      request,
      "tree.list",
      "s3:bucket-a",
      async () => ({ nodes: [1, 2, 3], truncated: false }),
      (page) => ({ itemsListed: page.nodes.length, truncated: page.truncated }),
    );

    expect(result).toEqual({ nodes: [1, 2, 3], truncated: false });
    const event = onlyEvent();
    expect(event).toMatchObject({
      type: "resource_operation",
      action: "tree.list",
      target: "s3:bucket-a",
      result: "success",
      user: "alice",
      role: "user",
      ip: "203.0.113.5",
      forwardedFor: "203.0.113.5",
      userAgent: "test-agent/1.0",
      connectionId: "res-1",
      connectionName: "Blob store",
      engine: "s3",
      counts: { itemsListed: 3, truncated: false },
    });
    expect(typeof event.duration).toBe("number");
    expect(event).not.toHaveProperty("reason");
  });

  test("a read with no details records no counts, and the role stands in for a missing username", async () => {
    await auditedResourceRead(
      { ...ctx, session: { role: "admin" } },
      request,
      "resource.meta",
      "s3:x",
      async () => "ok",
    );
    const event = onlyEvent();
    expect(event).not.toHaveProperty("counts");
    expect(event.user).toBe("admin");
  });

  test.each([
    [new ResourceNotFoundError("gone"), "resource_not_found"],
    [new ResourceOperationUnsupportedError("no"), "resource_unsupported"],
    [new ResourceConflictError("busy"), "resource_conflict"],
    [new ResourceInvalidRequestError("bad"), "resource_invalid_request"],
    [new ResourceRouteError("bad", 400), "resource_invalid_request"],
    [new ResourceConnectionError("down"), "resource_failed"],
    [new Error("boom"), "resource_failed"],
  ])("a failed read rethrows %p and records one failure with reason %p", async (error, reason) => {
    await expect(
      auditedResourceRead(ctx, request, "blob.preview", "s3:b/k", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(onlyEvent()).toMatchObject({ result: "failure", reason, action: "blob.preview" });
  });

  test("a broken sink never fails the read or hides its error", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    mockEmitAuditEvent.mockImplementation(() => {
      throw new Error("sink down");
    });
    try {
      await expect(auditedResourceRead(ctx, request, "tree.list", "s3:/", async () => 7)).resolves.toBe(7);
      const failure = new Error("provider down");
      await expect(
        auditedResourceRead(ctx, request, "tree.list", "s3:/", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  test("a counting bug is logged and the read still succeeds, recorded without counts", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const result = await auditedResourceRead(
        ctx,
        request,
        "tree.list",
        "s3:/",
        async () => null,
        () => {
          throw new Error("cannot count null");
        },
      );
      expect(result).toBeNull();
      expect(onlyEvent()).not.toHaveProperty("counts");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("the write helpers carry the connection when a route passes it", () => {
    const correlationId = beginResourceWrite("alice", "blob.delete", "s3:b/k", request, ctx.connection);
    endResourceWrite("alice", "blob.delete", "s3:b/k", correlationId, null, request, ctx.connection);
    for (const call of mockEmitAuditEvent.mock.calls) {
      expect(call[0]).toMatchObject({ connectionId: "res-1", connectionName: "Blob store", engine: "s3" });
    }
  });
});
