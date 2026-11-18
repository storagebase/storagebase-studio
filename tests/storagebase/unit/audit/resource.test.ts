import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import type { StoragebaseAuditEventInput } from "@/storagebase/audit/types";
import { logger } from "@/lib/logger";

/**
 * The resource audit helper (StorageBase fork, ported from the old fork's
 * tests/unit/lib/api/resource-audit.test.ts): the decision and outcome of a write join on one
 * correlation id, a read records exactly one event with counts only, the typed errors map onto the
 * closed reason set, and a broken sink is logged and never fails the action. The sink is replaced
 * at the module boundary with a controllable behaviour, so what is asserted is the event each
 * helper hands it.
 */

const recorded: StoragebaseAuditEventInput[] = [];
const behavior = {
  record: (event: StoragebaseAuditEventInput): void => {
    recorded.push(event);
  },
};

mock.module("@/storagebase/audit/sink", () => ({
  recordStoragebaseAuditEvent: (event: StoragebaseAuditEventInput) => behavior.record(event),
}));

const { auditedResourceRead, beginResourceWrite, endResourceWrite } = await import("@/storagebase/audit/resource");
const {
  ResourceConflictError,
  ResourceConnectionError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
  ResourceRouteError,
} = await import("@/storagebase/resources/errors");

const request = {
  headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "curl/8.7.1" }),
};

/** The broken-sink arm's handle: restores the behaviour and the log spy it installed. */
interface BrokenSink {
  restore(): void;
  logged(): number;
}

/** Makes the sink throw on every record; `restore` puts the recording behaviour back. */
function breakSink(): BrokenSink {
  const previous = behavior.record;
  behavior.record = () => {
    throw new Error("sink down");
  };
  const logged = spyOn(logger, "error").mockImplementation(() => {});
  return {
    restore() {
      behavior.record = previous;
      logged.mockRestore();
    },
    logged: () => logged.mock.calls.length,
  };
}

beforeEach(() => {
  recorded.length = 0;
  // The forwarded chain is recorded only while TRUST_PROXY_HEADERS is on, as upstream reads it.
  delete process.env.TRUST_PROXY_HEADERS;
});

function lastEvent(): StoragebaseAuditEventInput {
  const event = recorded.at(-1);
  if (event === undefined) throw new Error("no event was recorded");
  return event;
}

describe("the write helpers", () => {
  test("maps errors to the closed reason set", () => {
    const cases = [
      [new ResourceOperationUnsupportedError("x"), "resource_unsupported"],
      [new ResourceNotFoundError("x"), "resource_not_found"],
      [new ResourceConflictError("x"), "resource_conflict"],
      [new ResourceConnectionError("x"), "resource_failed"],
      [new Error("x"), "resource_failed"],
    ] as const;
    for (const [error, reason] of cases) {
      recorded.length = 0;
      const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
      endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, error);
      expect(lastEvent()).toMatchObject({ result: "failure", reason });
    }
  });

  test("decision and outcome join on one correlation id", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    expect(typeof correlationId).toBe("string");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null);

    expect(recorded).toHaveLength(2);
    const [decision, outcome] = recorded;
    expect(decision).toMatchObject({ type: "resource_operation", action: "blob.delete", result: "success" });
    expect(outcome).toMatchObject({ type: "resource_operation", action: "blob.delete", result: "success" });
    expect(outcome.correlationId).toBe(decision.correlationId);
    expect(outcome).not.toHaveProperty("reason");
  });

  test("a failed outcome carries the mapped reason", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, new ResourceNotFoundError("gone"));

    expect(recorded[1]).toMatchObject({ result: "failure", reason: "resource_not_found" });
  });

  test("a broken sink on the outcome still resolves", () => {
    const broken = breakSink();
    try {
      const correlationId = beginResourceWrite("admin", "message.purge", "kafka:t");
      expect(() => endResourceWrite("admin", "message.purge", "kafka:t", correlationId, null)).not.toThrow();
    } finally {
      broken.restore();
    }
  });

  test("a caller that passes its request gets the address and user agent on both events", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k", request);
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null, request);

    for (const event of recorded) {
      expect(event).toMatchObject({
        ip: "203.0.113.7",
        forwardedFor: "203.0.113.7, 10.0.0.1",
        userAgent: "curl/8.7.1",
      });
    }
  });

  test("a caller that passes no request records no request context", () => {
    const correlationId = beginResourceWrite("admin", "blob.delete", "s3:b/k");
    endResourceWrite("admin", "blob.delete", "s3:b/k", correlationId, null);

    for (const event of recorded) {
      expect(event).not.toHaveProperty("ip");
      expect(event).not.toHaveProperty("userAgent");
    }
  });

  test("a broken sink on the decision still returns an id", () => {
    const broken = breakSink();
    try {
      const correlationId = beginResourceWrite("admin", "message.purge", "kafka:t");
      expect(typeof correlationId).toBe("string");
    } finally {
      broken.restore();
    }
  });

  test("the write helpers carry the connection when a route passes it", () => {
    const connection = { id: "res-1", name: "Blob store", type: "s3" };
    const correlationId = beginResourceWrite("alice", "blob.delete", "s3:b/k", request, connection);
    endResourceWrite("alice", "blob.delete", "s3:b/k", correlationId, null, request, connection);
    for (const event of recorded) {
      expect(event).toMatchObject({ connectionId: "res-1", connectionName: "Blob store", engine: "s3" });
    }
    expect(lastEvent().correlationId).toBe(correlationId);
  });
});

describe("auditedResourceRead", () => {
  const ctx = {
    session: { role: "user", username: "alice" },
    route: "api/sb/resources/tree",
    connection: { id: "res-1", name: "Blob store", type: "s3" },
  };

  function onlyEvent(): StoragebaseAuditEventInput {
    expect(recorded).toHaveLength(1);
    return recorded[0];
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
      ip: "203.0.113.7",
      forwardedFor: "203.0.113.7, 10.0.0.1",
      userAgent: "curl/8.7.1",
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

  test("a read whose route passed no connection records no connection fields", async () => {
    await auditedResourceRead({ ...ctx, connection: undefined }, request, "resource.health", "s3:x", async () => "ok");
    const event = onlyEvent();
    expect(event).not.toHaveProperty("connectionId");
    expect(event).not.toHaveProperty("engine");
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
    const broken = breakSink();
    try {
      await expect(auditedResourceRead(ctx, request, "tree.list", "s3:/", async () => 7)).resolves.toBe(7);
      const failure = new Error("provider down");
      await expect(
        auditedResourceRead(ctx, request, "tree.list", "s3:/", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(broken.logged()).toBe(2);
    } finally {
      broken.restore();
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
});
