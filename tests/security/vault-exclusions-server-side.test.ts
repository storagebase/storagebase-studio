import { describe, test, expect, beforeEach, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { installAccessStore } from "../helpers/access-store";
import { installAuthMock } from "../helpers/auth-mock";

/**
 * Threat model for vault exclusion rules and the vault surfaces around them (StorageBase fork),
 * end to end through the real routes, the real managed-connection resolution and a real SQLite
 * fork store. Only the Key Vault ENGINE is doubled, through the resource registry.
 *
 * 1. A rule is matched on the server, against the vault identity of the connection the server
 *    resolved. For a MANAGED connection the browser never has the vault name — the regression
 *    this replaces keyed rules by an address the browser computed, so a managed vault's rules were
 *    saved under `https://.vault.azure.net` and applied to nothing. Nothing a request says about the
 *    vault changes which rules apply.
 * 2. Excluded objects are hidden for every caller, administrators included.
 * 3. No response of the vault workbench, the admin exclusion screen, the managed-connection lists
 *    or the connection meta/test/tree routes carries a managed connection's credential, and no
 *    audit line does either.
 *
 * Every name and value is a placeholder.
 */

const handle = installAccessStore();

let session: Record<string, unknown> | null = null;
installAuthMock({ getSession: () => session });

const store = await import("@/lib/access/store");
const { GET: managedResources } = await import("@/app/api/resources/managed/route");
const { GET: managedDatabases } = await import("@/app/api/connections/managed/route");
const { GET: adminConnections } = await import("@/app/api/admin/access/connections/route");
const exclusions = await import("@/app/api/resources/admin/vault-exclusions/route");
const { POST: preview } = await import("@/app/api/resources/admin/vault-exclusions/preview/route");
const { POST: applicable } = await import("@/app/api/resources/admin/vault-exclusions/applicable/route");
const { POST: objects } = await import("@/app/api/resources/vault/objects/route");
const { POST: object } = await import("@/app/api/resources/vault/object/route");
const { POST: reveal } = await import("@/app/api/resources/vault/secret/reveal/route");
const { POST: deleted } = await import("@/app/api/resources/vault/deleted/route");
const { POST: meta } = await import("@/app/api/resources/meta/route");
const { POST: tree } = await import("@/app/api/resources/tree/route");
const { POST: legacyRead } = await import("@/app/api/resources/secret/read/route");
const { BaseResourceProvider } = await import("@/lib/resources/base-provider");
const { registerResourceProviderLoader } = await import("@/lib/resources/registry");
const { clearResourceProviderCache } = await import("@/lib/resources/factory");
const { invalidateVaultExclusionCache } = await import("@/lib/resources/vault-exclusions-store");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { resetManagedUseTracking } = await import("@/lib/access/audit");

/** Every credential a managed connection could hold, each a distinct needle. */
const RESOURCE_SECRETS = {
  clientSecret: "needle-client-secret",
  accountKey: "needle-account-key",
  token: "needle-token",
  secretAccessKey: "needle-secret-access-key",
  sessionToken: "needle-session-token",
  connectionString: "needle-connection-string",
};
const DATABASE_SECRETS = {
  password: "needle-db-password",
  connectionString: "needle-db-connection-string",
  sentinelPassword: "needle-sentinel-password",
  ssl: { clientKey: "needle-ssl-client-key", clientCert: "cert", ca: "ca", mode: "require" },
};
const NEEDLES = [
  ...Object.values(RESOURCE_SECRETS),
  DATABASE_SECRETS.password,
  DATABASE_SECRETS.connectionString,
  DATABASE_SECRETS.sentinelPassword,
  DATABASE_SECRETS.ssl.clientKey,
];

/** What the fake engine was opened with, to prove the server used the REAL vault. */
const openedWith: Array<Record<string, unknown>> = [];

function summary(type: string, name: string) {
  return {
    type,
    name,
    enabled: true,
    createdOn: null,
    updatedOn: null,
    expiresOn: null,
    notBefore: null,
    tags: {},
    contentType: null,
    keyType: null,
    keySize: null,
    curve: null,
    subject: null,
    issuer: null,
    thumbprint: null,
  };
}

const SECRETS = ["app-setting", "break-glass-root"];

class FakeKeyVault extends BaseResourceProvider {
  constructor(config: Record<string, unknown>) {
    super(config as never);
    openedWith.push(config);
  }
  async connect() {
    this.setConnected(true);
  }
  async disconnect() {
    this.setConnected(false);
  }
  async getHealth() {
    return { status: "healthy" as const };
  }
  getCapabilities() {
    return {
      category: "vault" as const,
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "secret.read", "vault.secrets", "vault.secret.reveal", "vault.soft-delete"] as const,
    };
  }
  getLabels() {
    return { containerNoun: "Vault", itemNoun: "Secrets" };
  }
  async listNodes() {
    return {
      nodes: SECRETS.map((name) => ({
        id: `secret/${name}`,
        parentId: null,
        kind: "secret",
        name,
        hasChildren: false,
      })),
      truncated: false,
    };
  }
  async listVaultObjects(type: string) {
    return { objects: type === "secret" ? SECRETS.map((name) => summary("secret", name)) : [], truncated: false };
  }
  async describeVaultObject(type: string, name: string) {
    return {
      ...summary(type, name),
      version: "v1",
      recoveryLevel: null,
      keyOperations: [],
      versions: [],
      versionsTruncated: false,
    };
  }
  async revealSecret(name: string) {
    return { name, value: "object-value", version: "v1" };
  }
  async listDeletedVaultObjects(type: string) {
    return type === "secret" ? [{ type, name: "break-glass-old", deletedOn: null, scheduledPurgeDate: null }] : [];
  }
  async readSecret(path: string) {
    return { name: path, value: "object-value", metadata: null };
  }
}

const reader = { role: "user", username: "alice", provider: "entra", appRoles: ["Team.Vault.Read"] };
const admin = { role: "admin", username: "root", provider: "entra", appRoles: ["StorageBase.Admin"] };

const MANAGED = { connectionId: "managed:team-kv" };

function post(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://studio.test${path}`, {
    method,
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    headers: { "Content-Type": "application/json" },
  });
}

async function answer(response: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

async function listed(caller: Record<string, unknown>, body: Record<string, unknown> = MANAGED): Promise<string[]> {
  session = caller;
  const result = await answer(await objects(post("/api/resources/vault/objects", { ...body, type: "secret" })));
  expect(result.status).toBe(200);
  return (result.body.objects as Array<{ name: string }>).map((entry) => entry.name);
}

async function addRule(rule: Record<string, unknown>) {
  session = admin;
  const created = await answer(await exclusions.POST(post("/api/resources/admin/vault-exclusions", rule)));
  expect(created.status).toBe(201);
  return created;
}

const RULE = {
  vaultType: "azure-key-vault",
  vaultPattern: "^kv-prod-",
  vaultPatternKind: "regex",
  objectPattern: "break-glass-*",
  objectPatternKind: "glob",
  objectType: "secret",
};

beforeAll(() => {
  registerResourceProviderLoader("azure-key-vault", async () => ({ default: FakeKeyVault as never }));
});

beforeEach(async () => {
  await handle.reset();
  invalidateVaultExclusionCache();
  clearResourceProviderCache();
  clearRateLimitState();
  resetManagedUseTracking();
  getServerAuditBuffer().clear();
  openedWith.length = 0;
  session = null;
  await store.createGroup({ id: "vaults", name: "Vaults" }, "root");
  await store.createBinding({ appRoleValue: "Team.Vault.Read", groupId: "vaults", permission: "read" }, "root");
  await store.createManagedConnection(
    {
      id: "team-kv",
      kind: "resource",
      type: "azure-key-vault",
      name: "Team vault",
      groupIds: ["vaults"],
      config: {
        vaultName: "kv-prod-app",
        tenantId: "tenant-placeholder",
        clientId: "client-placeholder",
        ...RESOURCE_SECRETS,
      },
    },
    "root",
  );
  await store.createManagedConnection(
    {
      id: "orders",
      kind: "database",
      type: "postgres",
      name: "Orders",
      groupIds: ["vaults"],
      config: { host: "db.internal", port: 5432, user: "app", database: "orders", ...DATABASE_SECRETS },
    },
    "root",
  );
});

describe("1. rules are matched on the server, against the vault the server resolved", () => {
  test("a regex on the vault NAME hides a managed vault's objects — the name the browser never had", async () => {
    expect(await listed(reader)).toEqual(SECRETS);
    await addRule(RULE);
    expect(await listed(reader)).toEqual(["app-setting"]);
    // The engine was opened with the decrypted record: the real vault, the real credential.
    expect(openedWith.at(-1)).toMatchObject({ vaultName: "kv-prod-app", clientSecret: RESOURCE_SECRETS.clientSecret });
  });

  test("nothing a request says about the vault changes which rules apply", async () => {
    await addRule(RULE);
    // An inline connection riding beside the managed id is ignored: the id resolves on the server.
    expect(
      await listed(reader, {
        ...MANAGED,
        connection: { id: "x", name: "x", type: "azure-key-vault", vaultName: "kv-dev" },
      }),
    ).toEqual(["app-setting"]);
    // The admin API takes no vault address at all: a rule names vaults by pattern, and is matched per request.
    session = admin;
    const rules = (await answer(await exclusions.GET(post("/api/resources/admin/vault-exclusions", {}, "GET")))).body
      .rules as Array<Record<string, unknown>>;
    expect(Object.keys(rules[0])).not.toContain("address");
  });

  test("a rule for another vault does not apply, and a disabled rule hides nothing", async () => {
    await addRule({ ...RULE, vaultPattern: "kv-dev-app", vaultPatternKind: "exact" });
    await addRule({ ...RULE, enabled: false });
    expect(await listed(reader)).toEqual(SECRETS);
  });

  test("the migrated bogus per-vault key hides nothing, and a migrated real one applies", async () => {
    await handle.store.setSetting(
      "vault-exclusions:azure-key-vault:https://.vault.azure.net",
      { rules: [{ pattern: "*", kind: "glob", objectType: "any", note: "" }] },
      "root",
    );
    await handle.store.setSetting(
      "vault-exclusions:azure-key-vault:https://kv-prod-app.vault.azure.net",
      { rules: [{ pattern: "break-glass-*", kind: "glob", objectType: "secret", note: "" }] },
      "root",
    );
    expect(await listed(reader)).toEqual(["app-setting"]);
  });
});

describe("2. hidden for every caller, administrators included, on every vault surface", () => {
  test("lists drop it; by-name calls answer 404; the tree and legacy read agree", async () => {
    await addRule(RULE);
    for (const caller of [reader, admin]) {
      expect(await listed(caller)).toEqual(["app-setting"]);
      session = caller;
      for (const [route, path, body] of [
        [object, "/api/resources/vault/object", { type: "secret", name: "break-glass-root" }],
        [reveal, "/api/resources/vault/secret/reveal", { name: "BREAK-GLASS-ROOT" }],
        [legacyRead, "/api/resources/secret/read", { path: "secret/break-glass-root" }],
      ] as const) {
        expect((await route(post(path, { ...MANAGED, ...body }))).status).toBe(404);
      }
      const gone = await answer(await deleted(post("/api/resources/vault/deleted", { ...MANAGED, type: "secret" })));
      expect(gone.body.deleted).toEqual([]);
      const page = await answer(await tree(post("/api/resources/tree", MANAGED)));
      expect((page.body.nodes as Array<{ name: string }>).map((node) => node.name)).toEqual(["app-setting"]);
    }
  });

  test("the admin preview and the workbench count see the managed vault too — counts only", async () => {
    await addRule(RULE);
    session = admin;
    const counted = await answer(await applicable(post("/api/resources/admin/vault-exclusions/applicable", MANAGED)));
    expect(counted.body).toEqual({ applicableRules: 1 });
    const previewed = await answer(await preview(post("/api/resources/admin/vault-exclusions/preview", MANAGED)));
    expect(previewed.body).toEqual({ applicableRules: 1, counts: { secret: { total: 2, hidden: 1 } } });
    expect(previewed.text).not.toContain("break-glass");
    session = reader;
    expect((await applicable(post("/api/resources/admin/vault-exclusions/applicable", MANAGED))).status).toBe(403);
  });
});

describe("3. no managed credential leaves the server", () => {
  test("no response of any vault, admin-exclusion or listing route, for any caller, and no audit line carries one", async () => {
    await addRule(RULE);
    const texts: string[] = [];
    for (const caller of [reader, admin]) {
      session = caller;
      texts.push((await answer(await managedResources())).text);
      texts.push((await answer(await managedDatabases())).text);
      texts.push((await answer(await meta(post("/api/resources/meta", MANAGED)))).text);
      texts.push((await answer(await tree(post("/api/resources/tree", MANAGED)))).text);
      texts.push(
        (await answer(await objects(post("/api/resources/vault/objects", { ...MANAGED, type: "secret" })))).text,
      );
      texts.push(
        (
          await answer(
            await object(post("/api/resources/vault/object", { ...MANAGED, type: "secret", name: "app-setting" })),
          )
        ).text,
      );
      texts.push(
        (await answer(await reveal(post("/api/resources/vault/secret/reveal", { ...MANAGED, name: "app-setting" }))))
          .text,
      );
      texts.push(
        (await answer(await deleted(post("/api/resources/vault/deleted", { ...MANAGED, type: "secret" })))).text,
      );
      texts.push((await answer(await exclusions.GET(post("/api/resources/admin/vault-exclusions", {}, "GET")))).text);
      texts.push((await answer(await preview(post("/api/resources/admin/vault-exclusions/preview", MANAGED)))).text);
      texts.push(
        (await answer(await applicable(post("/api/resources/admin/vault-exclusions/applicable", MANAGED)))).text,
      );
      texts.push((await answer(await adminConnections(post("/api/admin/access/connections", {}, "GET")))).text);
    }
    texts.push(JSON.stringify(getServerAuditBuffer().getAll()));
    for (const text of texts) {
      for (const needle of NEEDLES) expect(text).not.toContain(needle);
    }
  });

  test("the user-facing managed list carries no vault name, tenant or client id either", async () => {
    session = reader;
    const text = (await answer(await managedResources())).text;
    for (const detail of ["kv-prod-app", "tenant-placeholder", "client-placeholder"])
      expect(text).not.toContain(detail);
  });
});
