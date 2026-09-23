import { describe, test, expect, mock, beforeEach } from "bun:test";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";
import {
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
