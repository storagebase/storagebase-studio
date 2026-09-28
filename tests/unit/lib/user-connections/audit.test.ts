import { describe, expect, spyOn, test } from "bun:test";
import * as audit from "@/lib/audit";
import { logger } from "@/lib/logger";
import { auditSecretsMigrated } from "@/lib/user-connections/audit";

/**
 * The `connection_secrets_migrated` event: count only, never names or values —
 * and a broken sink never undoes a migration that has already been written.
 */

describe("auditSecretsMigrated", () => {
  test("zero moved emits nothing", () => {
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => undefined as never);
    try {
      auditSecretsMigrated("alice", "database", 0);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  test("a move emits its count and nothing identifying", () => {
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => undefined as never);
    try {
      auditSecretsMigrated("alice", "resource", 2);
      expect(emit).toHaveBeenCalledTimes(1);
      const event = emit.mock.calls[0][0] as Record<string, unknown>;
      expect(event).toMatchObject({ type: "connection_secrets_migrated", target: "resource", user: "alice" });
      expect(JSON.stringify(event)).not.toContain("c1");
    } finally {
      emit.mockRestore();
    }
  });

  test("a broken sink is logged, never thrown", () => {
    const emit = spyOn(audit, "emitAuditEvent").mockImplementation(() => {
      throw new Error("sink down");
    });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(() => auditSecretsMigrated("alice", "database", 1)).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      emit.mockRestore();
      error.mockRestore();
    }
  });
});
