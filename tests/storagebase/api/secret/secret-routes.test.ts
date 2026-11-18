import { describe, test, expect, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { ResourceConnectionError } from "@/storagebase/resources/errors";
import {
  auditEvents,
  calls,
  connection,
  factory,
  fakeProvider,
  flags,
  listing,
  request,
  resetHarness,
  session,
} from "./secret-route-harness";

// The harness registers the process-wide mocks; importing it first is the
// contract (the routes and handle-request resolve their imports afterwards).
import "./secret-route-harness";

const { POST: postBrowse } = await import("@/app/api/sb/secret/browse/route");
const { POST: postPublish } = await import("@/app/api/sb/secret/publish/route");
const { POST: postPurge } = await import("@/app/api/sb/secret/purge/route");

describe("/api/sb/secret routes (generic browse/publish/purge over VaultOperations)", () => {
  beforeEach(resetHarness);

  test("browse answers a bounded page and audits one message.browse read", async () => {
    listing.page = {
      nodes: [
        { id: "mount/storagebase/a", parentId: "mount/storagebase", kind: "secret", name: "a", hasChildren: false },
      ],
      truncated: false,
    };
    const res = await postBrowse(request("/api/sb/secret/browse", { destination: "storagebase", limit: 10 }));
    const data = await parseResponseJSON<{ messages: unknown[]; truncated: boolean }>(res);
    expect(res.status).toBe(200);
    expect(data.messages).toHaveLength(1);
    expect(calls).toEqual([{ method: "listSecrets", args: ["storagebase", null] }]);
    expect(auditEvents()[0]).toMatchObject({
      type: "resource_operation",
      action: "message.browse",
      result: "success",
      counts: { messagesRead: 1, limit: 10, truncated: false },
    });
  });

  test("browse splits a folder destination and reports both truncation sources", async () => {
    await postBrowse(request("/api/sb/secret/browse", { destination: "storagebase/nested" }));
    expect(calls[0]?.args).toEqual(["storagebase", "nested"]);

    calls.length = 0;
    await postBrowse(request("/api/sb/secret/browse", { destination: "storagebase/nested/" }));
    expect(calls[0]?.args).toEqual(["storagebase", "nested"]);

    calls.length = 0;
    listing.page = {
      nodes: [
        { id: "a", parentId: null, kind: "secret", name: "a", hasChildren: false },
        { id: "b", parentId: null, kind: "secret", name: "b", hasChildren: false },
      ],
      truncated: false,
    };
    const truncated = await postBrowse(request("/api/sb/secret/browse", { destination: "storagebase", limit: 1 }));
    expect((await parseResponseJSON<{ messages: unknown[]; truncated: boolean }>(truncated)).truncated).toBe(true);

    listing.page = { nodes: [], truncated: true };
    const flagged = await postBrowse(request("/api/sb/secret/browse", { destination: "storagebase" }));
    expect((await parseResponseJSON<{ truncated: boolean }>(flagged)).truncated).toBe(true);
  });

  test("browse validates the destination and the limit", async () => {
    for (const body of [
      { destination: "", limit: 10 },
      { limit: 10 },
      { destination: "storagebase", limit: 0 },
      { destination: "storagebase", limit: 101 },
      { destination: "storagebase", limit: 2.5 },
      { destination: "storagebase", limit: "10" },
    ]) {
      expect((await postBrowse(request("/api/sb/secret/browse", body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("publish writes the body verbatim and records one decision + outcome", async () => {
    const res = await postPublish(
      request("/api/sb/secret/publish", { destination: "storagebase/plain", body: "just-text" }),
    );
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ published: boolean }>(res)).published).toBe(true);
    expect(calls).toEqual([{ method: "writeSecret", args: ["storagebase/plain", "just-text"] }]);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "resource_operation", action: "message.publish", result: "success" });
    expect(events[1]).toMatchObject({ result: "success" });
    expect(events[1]?.correlationId).toBe(events[0]?.correlationId);
    expect(events[1]).not.toHaveProperty("reason");
  });

  test("publish folds attributes into a JSON secret, with an empty map as a verbatim write", async () => {
    await postPublish(
      request("/api/sb/secret/publish", {
        destination: "storagebase/config",
        body: "primary",
        attributes: { owner: "ops", region: "eu" },
      }),
    );
    expect(calls[0]?.args[1]).toBe(JSON.stringify({ value: "primary", owner: "ops", region: "eu" }));

    calls.length = 0;
    await postPublish(
      request("/api/sb/secret/publish", { destination: "storagebase/config", body: "plain", attributes: {} }),
    );
    expect(calls[0]?.args[1]).toBe("plain");
  });

  test("publish validates the body and the attributes map", async () => {
    for (const body of [
      { destination: "storagebase/config" },
      { destination: "storagebase/config", body: "" },
      { destination: "storagebase/config", body: 42 },
      { destination: "storagebase/config", body: "x", attributes: ["k"] },
      { destination: "storagebase/config", body: "x", attributes: null },
      { destination: "storagebase/config", body: "x", attributes: { k: 42 } },
      { destination: "storagebase/config", body: "x", attributes: { value: "override" } },
    ]) {
      expect((await postPublish(request("/api/sb/secret/publish", body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("a provider failure on publish is a 502 with resource_failed in the outcome", async () => {
    factory.provider = {
      ...fakeProvider,
      writeSecret: async () => {
        throw new ResourceConnectionError("Vault is sealed");
      },
    };
    const res = await postPublish(request("/api/sb/secret/publish", { destination: "storagebase/plain", body: "x" }));
    expect(res.status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({
      type: "resource_operation",
      action: "message.publish",
      result: "failure",
      reason: "resource_failed",
    });
  });

  test("purge removes a secret and records one decision + outcome", async () => {
    const res = await postPurge(request("/api/sb/secret/purge", { destination: "storagebase/plain" }));
    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ purged: boolean }>(res)).purged).toBe(true);
    expect(calls).toEqual([{ method: "deleteSecret", args: ["storagebase/plain"] }]);

    const events = auditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ action: "message.purge", result: "success" });
    expect(events[1]?.correlationId).toBe(events[0]?.correlationId);
  });

  test("purge refuses a non-admin session with the upstream admin-required answer", async () => {
    session.current = { role: "user", username: "bob" };
    const res = await postPurge(request("/api/sb/secret/purge", { destination: "storagebase/plain" }));
    expect(res.status).toBe(403);
    expect(await parseResponseJSON(res)).toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(calls).toEqual([]);
    expect(auditEvents()).toEqual([]);
  });

  test("purge validates its destination and survives a provider failure", async () => {
    expect((await postPurge(request("/api/sb/secret/purge", { destination: "" }))).status).toBe(400);
    expect((await postPurge(request("/api/sb/secret/purge", {}))).status).toBe(400);

    factory.provider = {
      ...fakeProvider,
      deleteSecret: async () => {
        throw new ResourceConnectionError("channel closed");
      },
    };
    const res = await postPurge(request("/api/sb/secret/purge", { destination: "storagebase/plain" }));
    expect(res.status).toBe(502);
    expect(auditEvents()[1]).toMatchObject({ action: "message.purge", result: "failure", reason: "resource_failed" });
  });

  test("every route requires a session and parses no body without one", async () => {
    session.current = null;
    const req = createMockRequest("/api/sb/secret/browse", {
      method: "POST",
      body: { connection, destination: "storagebase/plain", body: "x" },
    }) as never;
    for (const post of [postBrowse, postPublish, postPurge]) {
      expect((await post(req)).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test("an undeclared operation is a 400 the route decides", async () => {
    flags.current = ["tree"];
    for (const [post, path, body] of [
      [postBrowse, "/api/sb/secret/browse", { destination: "storagebase" }],
      [postPublish, "/api/sb/secret/publish", { destination: "storagebase/plain", body: "x" }],
      [postPurge, "/api/sb/secret/purge", { destination: "storagebase/plain" }],
    ] as const) {
      const res = await post(request(path, body));
      expect(res.status).toBe(400);
      expect(await parseResponseJSON<{ code: string }>(res)).toMatchObject({
        code: "SB_RESOURCE_OPERATION_UNSUPPORTED",
      });
    }
  });
});
