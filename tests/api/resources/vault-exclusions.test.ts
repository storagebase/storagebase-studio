import { describe, test, expect, beforeEach } from "bun:test";
import {
  auditEvents,
  connection,
  EXCLUSION_KEY,
  factory,
  fakeProvider,
  providerCalls,
  request,
  resetHarness,
  session,
  settings,
  store,
} from "./vault-route-harness";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { normalizedVaultAddress } from "@/lib/resources/vault-exclusions";

const { GET, PUT } = await import("@/app/api/resources/admin/vault-exclusions/route");
const { POST: preview } = await import("@/app/api/resources/admin/vault-exclusions/preview/route");
const { POST: legacyRead } = await import("@/app/api/resources/secret/read/route");
const { POST: legacyWrite } = await import("@/app/api/resources/secret/write/route");
const { POST: legacyDelete } = await import("@/app/api/resources/secret/delete/route");
const { POST: tree } = await import("@/app/api/resources/tree/route");

const address = normalizedVaultAddress(connection as never);
const RULE = { pattern: "hidden-*", kind: "glob", objectType: "any", note: "compliance" };

function get(query: Record<string, string>) {
  return GET(createMockRequest(`/api/resources/admin/vault-exclusions?${new URLSearchParams(query)}`) as never);
}

function put(body: unknown) {
  return PUT(
    createMockRequest("/api/resources/admin/vault-exclusions", {
      method: "PUT",
      body,
      headers: { "user-agent": "vault-test-agent" },
    }) as never,
  );
}

describe("admin vault exclusion API", () => {
  beforeEach(() => resetHarness());

  test("admins read and replace a vault's rules; the change is audited before/after", async () => {
    const empty = await get({ type: "azure-key-vault", address });
    expect(await parseResponseJSON<Record<string, unknown>>(empty)).toEqual({ rules: [] });

    const saved = await put({ type: "azure-key-vault", address, rules: [RULE] });
    expect(saved.status).toBe(200);
    expect(settings.get(EXCLUSION_KEY)).toEqual({ rules: [RULE] });
    const update = auditEvents.find((event) => event.action === "vault.exclusions.update");
    expect(update).toMatchObject({ result: "success", user: "admin", target: `azure-key-vault:${address}` });
    expect(JSON.parse(update?.details as string)).toEqual({ before: [], after: [RULE] });
    expect(auditEvents.find((event) => event.action === "vault.exclusions.read")).toBeDefined();

    expect(await parseResponseJSON<Record<string, unknown>>(await get({ type: "azure-key-vault", address }))).toEqual({
      rules: [RULE],
    });
  });

  test("non-admins are refused, anonymous callers are not authenticated", async () => {
    session.current = { role: "user", username: "alice" };
    expect((await get({ type: "azure-key-vault", address })).status).toBe(403);
    expect((await put({ type: "azure-key-vault", address, rules: [] })).status).toBe(403);
    expect((await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: [] }))).status).toBe(403);
    session.current = null;
    expect((await get({ type: "azure-key-vault", address })).status).toBe(401);
    expect((await put({ type: "azure-key-vault", address, rules: [] })).status).toBe(401);
  });

  test("bad vaults and bad rules are 400s, audited as failed updates", async () => {
    expect((await get({ type: "s3", address })).status).toBe(400);
    expect((await get({ type: "azure-key-vault", address: "" })).status).toBe(400);
    expect(
      (await put({ type: "azure-key-vault", address, rules: [{ ...RULE, kind: "regex", pattern: "(a+)+" }] })).status,
    ).toBe(400);
    expect(auditEvents.at(-1)).toMatchObject({
      action: "vault.exclusions.update",
      result: "failure",
      target: `azure-key-vault:${address}`,
    });
    const unparsable = await PUT(
      new Request("http://localhost:3000/api/resources/admin/vault-exclusions", { method: "PUT", body: "{" }) as never,
    );
    expect(unparsable.status).toBe(400);
    expect(auditEvents.at(-1)).toMatchObject({ target: "vault:unknown" });
  });

  test("without a durable store, saving is refused and the prior read is tolerated", async () => {
    store.mode = "none";
    const res = await put({ type: "azure-key-vault", address, rules: [RULE] });
    expect(res.status).toBe(409);
    store.mode = "broken";
    expect((await put({ type: "azure-key-vault", address, rules: [] })).status).toBe(500);
  });

  test("an audit sink failure never fails the admin call", async () => {
    const { emitAuditEvent } = await import("@/lib/audit");
    (emitAuditEvent as unknown as { mockImplementationOnce(fn: () => never): void }).mockImplementationOnce(() => {
      throw new Error("sink down");
    });
    expect((await get({ type: "azure-key-vault", address })).status).toBe(200);
  });

  test("preview answers counts per declared type, never names", async () => {
    const res = await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: [RULE] }));
    const body = await parseResponseJSON<{ counts: Record<string, { total: number; hidden: number }> }>(res);
    expect(body.counts).toEqual({
      secret: { total: 2, hidden: 1 },
      key: { total: 1, hidden: 0 },
      certificate: { total: 1, hidden: 0 },
    });
    expect(JSON.stringify(body)).not.toContain("hidden-secret");
    expect(auditEvents.at(-1)).toMatchObject({ action: "vault.exclusions.preview" });
    // Existing rules do not narrow the preview: it reads unfiltered.
    settings.set(EXCLUSION_KEY, { rules: [{ ...RULE, pattern: "*" }] });
    const again = await parseResponseJSON<{ counts: Record<string, { total: number }> }>(
      await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: [] })),
    );
    expect(again.counts.secret.total).toBe(2);
    expect((await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: "x" }))).status).toBe(400);
  });
});

describe("the legacy secret and tree routes honour the same rules", () => {
  beforeEach(() => {
    resetHarness();
    settings.set(EXCLUSION_KEY, { rules: [RULE] });
  });

  test("read, write and delete of an excluded path are 404s the provider never sees", async () => {
    for (const [route, body] of [
      [legacyRead, { path: "secret/hidden-secret" }],
      [legacyWrite, { path: "hidden-secret", value: "x" }],
      [legacyDelete, { path: "secret/hidden-secret" }],
    ] as const) {
      expect((await route(request("/api/resources/secret", body))).status).toBe(404);
    }
    expect(providerCalls).toHaveLength(0);
    expect((await legacyRead(request("/api/resources/secret/read", { path: "secret/db-password" }))).status).toBe(200);
  });

  test("KMS paths are matched as keys", async () => {
    settings.set("vault-exclusions:aws-kms:eu-west-1", { rules: [{ ...RULE, objectType: "key" }] });
    const kms = { ...connection, type: "aws-kms", region: "eu-west-1" };
    const req = createMockRequest("/api/resources/secret/read", {
      method: "POST",
      body: { connection: kms, path: "key/hidden-key" },
    });
    expect((await legacyRead(req as never)).status).toBe(404);
  });

  test("the tree drops excluded leaves for vaults and leaves other families alone", async () => {
    const page = await parseResponseJSON<{ nodes: Array<{ name: string }> }>(
      await tree(request("/api/resources/tree", {})),
    );
    expect(page.nodes.map((node) => node.name)).toEqual(["db-password"]);

    factory.provider = { ...fakeProvider, getCapabilities: () => ({ category: "blob", operations: ["tree"] }) };
    const blob = createMockRequest("/api/resources/tree", {
      method: "POST",
      body: { connection: { ...connection, type: "s3" } },
    });
    const blobPage = await parseResponseJSON<{ nodes: unknown[] }>(await tree(blob as never));
    expect(blobPage.nodes).toHaveLength(2);
  });

  test("non-vault connections pass the secret guard untouched", async () => {
    const { requireVisibleSecret } = await import("@/lib/api/resource-vault-workbench");
    await requireVisibleSecret({ ...connection, type: "s3" } as never, "hidden-secret");
  });
});
