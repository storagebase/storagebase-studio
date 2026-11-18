import { describe, test, expect } from "bun:test";
import type { AuditEvent } from "@/lib/audit";
import { storagebaseEventFromUpstream } from "@/storagebase/audit/upstream";

/** The S3 conversion: an upstream event becomes a fork event field-for-field, losing nothing. */

function upstream(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "up-1",
    timestamp: "2026-09-24T10:00:00.000Z",
    type: "login_success",
    action: "login",
    target: "POST /api/auth/login",
    user: "alice",
    result: "success",
    ...overrides,
  };
}

describe("storagebaseEventFromUpstream", () => {
  test("copies every field an upstream event carries, and mints none of the fork's extended ones", () => {
    const converted = storagebaseEventFromUpstream(
      upstream({
        container: "public",
        engineUser: "app",
        connectionName: "Orders DB",
        duration: 42,
        details: "Signed in with a password",
        ip: "203.0.113.9",
        reason: "oidc_no_role",
        bucket: "login_account",
        correlationId: "corr-7",
        passkey: "pk-3",
      }),
    );
    expect(converted).toEqual({
      id: "up-1",
      timestamp: "2026-09-24T10:00:00.000Z",
      type: "login_success",
      action: "login",
      target: "POST /api/auth/login",
      container: "public",
      engineUser: "app",
      connectionName: "Orders DB",
      user: "alice",
      result: "success",
      duration: 42,
      details: "Signed in with a password",
      ip: "203.0.113.9",
      reason: "oidc_no_role",
      bucket: "login_account",
      correlationId: "corr-7",
      passkey: "pk-3",
    });
  });

  test("a minimal event converts to a minimal fork event, keeping its id and timestamp", () => {
    const event = upstream();
    expect(storagebaseEventFromUpstream(event)).toEqual({
      id: "up-1",
      timestamp: "2026-09-24T10:00:00.000Z",
      type: "login_success",
      action: "login",
      target: "POST /api/auth/login",
      user: "alice",
      result: "success",
    });
  });

  test("a query-style event type passes through unchanged: the fork composes upstream's union, it does not rewrite it", () => {
    const converted = storagebaseEventFromUpstream(upstream({ type: "object_edit", action: "applied" }));
    expect(converted.type).toBe("object_edit");
  });
});
