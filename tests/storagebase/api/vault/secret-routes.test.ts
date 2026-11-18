import { describe, test, expect, beforeEach } from "bun:test";
import {
  auditEvents,
  fakeProvider,
  factory,
  flags,
  providerCalls,
  request,
  resetHarness,
  session,
} from "./vault-route-harness";
import { parseResponseJSON } from "../../../helpers/mock-next";
import { ResourceConnectionError } from "@/storagebase/resources/errors";

/**
 * The generic VaultOperations secret routes under /api/sb/vault/secret —
 * `read`, `write`, `delete` — ported from the old fork's
 * tests/api/resources/secret-routes.test.ts. The vault-exclusion half of the
 * legacy file is gone with the feature (decision D3); everything else keeps
 * its shape, plus the fork's new guarantee: `read` answers its value
 * `Cache-Control: no-store`, exactly like the workbench's reveal.
 */
const postRead = (await import("@/app/api/sb/vault/secret/read/route")).POST;
const postWrite = (await import("@/app/api/sb/vault/secret/write/route")).POST;
const postDelete = (await import("@/app/api/sb/vault/secret/delete/route")).POST;

async function call(route: string, body: Record<string, unknown>) {
  const handlers = { read: postRead, write: postWrite, delete: postDelete } as Record<string, typeof postRead>;
  return handlers[route](request(`/api/sb/vault/secret/${route}`, { path: body.path, ...body }));
}

describe("secret routes", () => {
  beforeEach(() => resetHarness());

  test("read answers the value, no-store, and audits the access", async () => {
    const res = await call("read", { path: "storagebase/fixture" });
    const data = await parseResponseJSON<{ value: string }>(res);
    expect(res.status).toBe(200);
    expect(data.value).toBe("legacy-value");
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Reads audit like writes (the deliberate exception): secret material
    // access is what operators filter the trail for.
    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "resource_operation", action: "secret.read", result: "success" });
    expect((events[1] as { correlationId: string }).correlationId).toBe(
      (events[0] as { correlationId: string }).correlationId,
    );
  });

  test("read without a path is a 400", async () => {
    expect((await call("read", { path: "" })).status).toBe(400);
    expect(providerCalls).toHaveLength(0);
  });

  test("write saves and records decision + outcome", async () => {
    const res = await call("write", { path: "storagebase/new", value: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ written: boolean }>(res)).written).toBe(true);
    expect(providerCalls[0]).toMatchObject({ method: "writeSecret", args: ["storagebase/new", '{"a":1}'] });

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "secret.write", result: "success" });
    expect((events[1] as { correlationId: string }).correlationId).toBe(
      (events[0] as { correlationId: string }).correlationId,
    );
  });

  test("write without a string value is a 400", async () => {
    expect((await call("write", { path: "storagebase/new", value: 42 })).status).toBe(400);
    expect(providerCalls).toHaveLength(0);
  });

  test("delete removes and records decision + outcome", async () => {
    const res = await call("delete", { path: "storagebase/old" });
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ deleted: boolean }>(res)).deleted).toBe(true);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "secret.delete", result: "success" });
    expect((events[1] as { correlationId: string }).correlationId).toBe(
      (events[0] as { correlationId: string }).correlationId,
    );
  });

  test("a provider failure on read is a 502 with resource_failed in the outcome", async () => {
    factory.provider = {
      ...fakeProvider,
      readSecret: async () => Promise.reject(new ResourceConnectionError("vault sealed")),
    };
    expect((await call("read", { path: "storagebase/fixture" })).status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "secret.read", result: "failure", reason: "resource_failed" });
  });

  test("a provider failure on delete is a 502 with resource_failed in the outcome", async () => {
    factory.provider = {
      ...fakeProvider,
      deleteSecret: async () => Promise.reject(new ResourceConnectionError("vault sealed")),
    };
    expect((await call("delete", { path: "storagebase/old" })).status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "secret.delete", result: "failure", reason: "resource_failed" });
  });

  test("routes require a session", async () => {
    session.current = null;
    expect((await call("delete", { path: "storagebase/old" })).status).toBe(401);
    expect(providerCalls).toHaveLength(0);
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    factory.provider = {
      ...fakeProvider,
      getCapabilities: () => ({
        ...fakeProvider.getCapabilities(),
        operations: (flags.current = ["tree"]),
      }),
    };
    const res = await call("write", { path: "storagebase/new", value: "x" });
    expect(res.status).toBe(400);
    const data = await parseResponseJSON<{ code: string }>(res);
    expect(data.code).toBe("SB_RESOURCE_OPERATION_UNSUPPORTED");
  });
});
