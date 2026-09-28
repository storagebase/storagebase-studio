import { describe, test, expect, beforeEach } from "bun:test";
import {
  auditEvents,
  connection,
  excludeRules,
  EXCLUSIONS_KEY,
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

const { GET, POST, PUT, DELETE } = await import("@/app/api/resources/admin/vault-exclusions/route");
const { POST: preview } = await import("@/app/api/resources/admin/vault-exclusions/preview/route");
const { POST: applicable } = await import("@/app/api/resources/admin/vault-exclusions/applicable/route");
const { POST: legacyRead } = await import("@/app/api/resources/secret/read/route");
const { POST: legacyWrite } = await import("@/app/api/resources/secret/write/route");
const { POST: legacyDelete } = await import("@/app/api/resources/secret/delete/route");
const { POST: tree } = await import("@/app/api/resources/tree/route");
const { POST: objects } = await import("@/app/api/resources/vault/objects/route");

const RULE = {
  vaultType: "azure-key-vault",
  vaultPattern: "exam*",
  vaultPatternKind: "glob",
  objectPattern: "hidden-*",
  objectPatternKind: "glob",
  objectType: "any",
  note: "compliance",
};

type Body = Record<string, unknown>;

function send(method: "POST" | "PUT", body: unknown) {
  const req = createMockRequest("/api/resources/admin/vault-exclusions", {
    method,
    body,
    headers: { "user-agent": "vault-test-agent" },
  }) as never;
  return method === "POST" ? POST(req) : PUT(req);
}

function remove(id: string) {
  return DELETE(
    createMockRequest(`/api/resources/admin/vault-exclusions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }) as never,
  );
}

async function list() {
  return parseResponseJSON<Body>(await GET(createMockRequest("/api/resources/admin/vault-exclusions") as never));
}

async function names(body: Body = {}) {
  const res = await objects(request("/api/resources/vault/objects", { type: "secret", ...body }));
  return (await parseResponseJSON<{ objects: Array<{ name: string }> }>(res)).objects.map((object) => object.name);
}

describe("admin vault exclusion API", () => {
  beforeEach(() => resetHarness());

  test("admins create, update, toggle and delete global rules; each change is audited before/after", async () => {
    expect(await list()).toEqual({ rules: [], storeAvailable: true });
    expect(auditEvents.at(-1)).toMatchObject({ action: "vault.exclusions.read", user: "admin" });

    const created = await send("POST", RULE);
    expect(created.status).toBe(201);
    const { rule } = await parseResponseJSON<{ rule: Body }>(created);
    expect(rule).toMatchObject({ ...RULE, enabled: true, updatedBy: "admin" });
    expect(auditEvents.at(-1)).toMatchObject({
      action: "vault.exclusions.create",
      result: "success",
      target: `vault-exclusion:${rule.id}`,
    });
    expect(JSON.parse(auditEvents.at(-1)?.details as string)).toEqual({ before: null, after: rule });
    // Applied at once, on the vault the SERVER derives from the connection.
    expect(await names()).toEqual(["db-password"]);

    const updated = await send("PUT", { ...RULE, id: rule.id, enabled: false });
    expect(updated.status).toBe(200);
    expect(JSON.parse(auditEvents.at(-1)?.details as string)).toMatchObject({
      before: { enabled: true },
      after: { enabled: false },
    });
    expect(await names()).toEqual(["db-password", "hidden-secret"]);

    const deleted = await remove(rule.id as string);
    expect(deleted.status).toBe(200);
    expect(auditEvents.at(-1)).toMatchObject({
      action: "vault.exclusions.delete",
      target: `vault-exclusion:${rule.id}`,
    });
    expect(((await list()).rules as unknown[]).length).toBe(0);
  });

  test("non-admins are refused and anonymous callers are not authenticated, on every method", async () => {
    session.current = { role: "user", username: "alice" };
    expect((await GET(createMockRequest("/api/resources/admin/vault-exclusions") as never)).status).toBe(403);
    expect((await send("POST", RULE)).status).toBe(403);
    expect((await send("PUT", { ...RULE, id: "x" })).status).toBe(403);
    expect((await remove("x")).status).toBe(403);
    expect((await preview(request("/api/resources/admin/vault-exclusions/preview", {}))).status).toBe(403);
    expect((await applicable(request("/api/resources/admin/vault-exclusions/applicable", {}))).status).toBe(403);
    session.current = null;
    expect((await GET(createMockRequest("/api/resources/admin/vault-exclusions") as never)).status).toBe(401);
    expect((await send("POST", RULE)).status).toBe(401);
    expect(settings.size).toBe(0);
  });

  test("bad rules, bodies and ids are 400s or 404s with the server's sentence, audited as failures", async () => {
    const unsafe = await send("POST", { ...RULE, vaultPattern: "(a+)+", vaultPatternKind: "regex" });
    expect(unsafe.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(unsafe)).error).toContain("repeated group");
    expect(auditEvents.at(-1)).toMatchObject({ action: "vault.exclusions.create", result: "failure" });
    const unparsable = await POST(
      new Request("http://localhost:3000/api/resources/admin/vault-exclusions", { method: "POST", body: "{" }) as never,
    );
    expect(unparsable.status).toBe(400);
    expect((await send("PUT", { ...RULE })).status).toBe(400);
    expect((await send("PUT", { ...RULE, id: "missing" })).status).toBe(404);
    expect((await remove("missing")).status).toBe(404);
    expect(
      (await DELETE(createMockRequest("/api/resources/admin/vault-exclusions", { method: "DELETE" }) as never)).status,
    ).toBe(400);
  });

  test("without a durable store, the list says so and saving is refused; a broken store is a failure", async () => {
    store.mode = "none";
    expect(await list()).toMatchObject({
      rules: [],
      storeAvailable: false,
      message: expect.stringContaining("STORAGE"),
    });
    expect((await send("POST", RULE)).status).toBe(409);
    store.mode = "broken";
    expect((await GET(createMockRequest("/api/resources/admin/vault-exclusions") as never)).status).toBe(502);
  });

  test("an audit sink failure never fails the admin call", async () => {
    const { emitAuditEvent } = await import("@/lib/audit");
    (emitAuditEvent as unknown as { mockImplementationOnce(fn: () => never): void }).mockImplementationOnce(() => {
      throw new Error("sink down");
    });
    expect((await GET(createMockRequest("/api/resources/admin/vault-exclusions") as never)).status).toBe(200);
  });
});

describe("preview and the applicable-rule count", () => {
  beforeEach(() => resetHarness());

  test("preview answers the saved rules' counts per declared type, never names", async () => {
    excludeRules([{ objectPattern: "hidden-*" }, { vaultPattern: "other-vault", vaultPatternKind: "exact" }]);
    const res = await preview(request("/api/resources/admin/vault-exclusions/preview", {}));
    const body = await parseResponseJSON<{ applicableRules: number; counts: Record<string, unknown> }>(res);
    expect(body).toEqual({
      applicableRules: 1,
      counts: {
        secret: { total: 2, hidden: 1 },
        key: { total: 1, hidden: 0 },
        certificate: { total: 1, hidden: 0 },
      },
    });
    expect(JSON.stringify(body)).not.toContain("hidden-secret");
    expect(auditEvents.at(-1)).toMatchObject({ action: "vault.exclusions.preview" });
  });

  test("preview of drafts reads unfiltered and validates them", async () => {
    excludeRules([{ objectPattern: "*" }]);
    const drafts = await parseResponseJSON<{ applicableRules: number; counts: Record<string, { total: number }> }>(
      await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: [] })),
    );
    expect(drafts.applicableRules).toBe(0);
    expect(drafts.counts.secret.total).toBe(2);
    expect((await preview(request("/api/resources/admin/vault-exclusions/preview", { rules: "x" }))).status).toBe(400);
    const invalid = await preview(
      request("/api/resources/admin/vault-exclusions/preview", { rules: [{ ...RULE, objectType: "blob" }] }),
    );
    expect((await parseResponseJSON<{ error: string }>(invalid)).error).toContain("Rule 1");
  });

  test("preview refuses a non-vault connection", async () => {
    const blob = createMockRequest("/api/resources/admin/vault-exclusions/preview", {
      method: "POST",
      body: { connection: { ...connection, type: "s3" } },
    });
    expect((await preview(blob as never)).status).toBe(400);
  });

  test("the workbench notice counts the enabled rules that apply to this vault", async () => {
    excludeRules([
      {},
      { enabled: false },
      { vaultType: "openbao" },
      { vaultPattern: "^exa", vaultPatternKind: "regex" },
    ]);
    const res = await applicable(request("/api/resources/admin/vault-exclusions/applicable", {}));
    expect(await parseResponseJSON<Body>(res)).toEqual({ applicableRules: 2 });
  });
});

describe("enforcement follows the connection the server runs, and the legacy routes honour it", () => {
  beforeEach(() => {
    resetHarness();
    excludeRules([
      { vaultType: "azure-key-vault", vaultPattern: "example", vaultPatternKind: "exact", objectPattern: "hidden-*" },
    ]);
  });

  test("an Azure endpoint wins over vaultName, exactly as the provider connects", async () => {
    // The request names vault "example" but connects to another vault: that vault's rules apply, not these.
    expect(await names({ connection: { ...connection, endpoint: "https://elsewhere.vault.azure.net" } })).toEqual([
      "db-password",
      "hidden-secret",
    ]);
    // And the other way: the endpoint IS the ruled vault, whatever vaultName says.
    expect(
      await names({ connection: { ...connection, vaultName: "decoy", endpoint: "https://EXAMPLE.vault.azure.net/" } }),
    ).toEqual(["db-password"]);
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

  test("KMS paths are matched as keys, by region", async () => {
    excludeRules([{ vaultType: "aws-kms", vaultPattern: "eu-*", objectType: "key", objectPattern: "hidden-*" }]);
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

  test("the rules live in one global setting", () => {
    expect([...settings.keys()]).toEqual([EXCLUSIONS_KEY]);
  });
});
