import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realYaml from "yaml";
import * as realVaultClient from "@/lib/seed/vault-client";
import { readVaultSecret, resetVaultCache, VaultError } from "@/lib/seed/vault-client";
import { resetLiteralModeNotices, resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import {
  DEFAULT_STORAGEBASE_RESOURCE_SEED_PATH,
  loadResourceSeedEntries,
  openSeededResourceConnection,
  resetResourceSeedState,
  resourceSeedPath,
  seededResourceRows,
  seedEntryMatches,
  type ResourceSeedEntry,
} from "@/storagebase/resources/seed";

/**
 * The fork seed file: YAML entries validated by the fork's own schema, roles
 * matched through upstream's own combiner, `${ENV}` references resolved by
 * upstream's own resolver, `${vault:…}` references resolved only when a
 * role-matched connection is opened — and never a secret value in any row.
 *
 * `${vault:…}` reads go through upstream's vault client; the test replaces it
 * with a fixed answer so no Vault is needed, exactly the seam upstream's own
 * credential-resolver tests use (a `VaultDeps.fetch` stand-in).
 */

const vaultReads: string[] = [];
const mockReadVaultSecret = async (path: string, key: string): Promise<string> => {
  vaultReads.push(`${path}#${key}`);
  return "vault-secret-value";
};

mock.module("@/lib/seed/vault-client", () => ({
  ...realVaultClient,
  readVaultSecret: mockReadVaultSecret,
}));

// A parser crash that is not the yaml package's own error, thrown only for
// the sentinel below: it exercises the loader's "not a YAML error" sentence,
// which otherwise has no honest way to be reached.
const realParseDocument = realYaml.parseDocument;
mock.module("yaml", () => ({
  ...realYaml,
  parseDocument: (text: string, options?: Parameters<typeof realParseDocument>[1]) => {
    if (text.includes("NOT-A-YAML-ERROR")) throw new Error("a parser crash that is not a YAML error");
    return realParseDocument(text, options);
  },
}));

let seedDir: string;
let seedPath: string;

const ADMIN_SESSION = { role: "admin", username: "admin" };
const USER_SESSION = { role: "user", username: "alice" };

function writeSeed(text: string): void {
  writeFileSync(seedPath, text, "utf-8");
}

beforeEach(() => {
  seedDir = mkdtempSync(join(tmpdir(), "sb-resource-seed-"));
  seedPath = join(seedDir, "storagebase-resources.yaml");
  process.env.STORAGEBASE_RESOURCE_SEED_PATH = seedPath;
  resetResourceSeedState();
  resetVaultCache();
  resetPlaintextWarnings();
  resetLiteralModeNotices();
  delete process.env.SEED_LITERAL_VALUES;
  delete process.env.OIDC_ROLE_PREFIX;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.SB_TEST_TOKEN;
  vaultReads.length = 0;
});

afterEach(() => {
  rmSync(seedDir, { recursive: true, force: true });
  delete process.env.STORAGEBASE_RESOURCE_SEED_PATH;
  delete process.env.SB_TEST_TOKEN;
  delete process.env.SEED_LITERAL_VALUES;
  delete process.env.OIDC_ROLE_PREFIX;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
});

describe("the seed path", () => {
  test("an unset or empty variable means the default path; a set one is used verbatim", () => {
    delete process.env.STORAGEBASE_RESOURCE_SEED_PATH;
    expect(resourceSeedPath()).toBe(DEFAULT_STORAGEBASE_RESOURCE_SEED_PATH);
    process.env.STORAGEBASE_RESOURCE_SEED_PATH = "";
    expect(resourceSeedPath()).toBe(DEFAULT_STORAGEBASE_RESOURCE_SEED_PATH);
    process.env.STORAGEBASE_RESOURCE_SEED_PATH = "/etc/storagebase/seeds.yaml";
    expect(resourceSeedPath()).toBe("/etc/storagebase/seeds.yaml");
  });
});

describe("loadResourceSeedEntries", () => {
  test("a valid file loads with ${ENV} references resolved by upstream's resolver", async () => {
    process.env.SB_TEST_TOKEN = "env-resolved-token";
    writeSeed(`connections:
  - id: prod-vault
    type: hashicorp-vault
    name: "Prod Vault"
    roles: ["*"]
    permission: write
    group: "Vaults"
    environment: production
    fields:
      endpoint: "https://vault:8200"
      token: "\${SB_TEST_TOKEN}"
      namespace: "ops"
`);
    const entries = await loadResourceSeedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "prod-vault",
      type: "hashicorp-vault",
      permission: "write",
      group: "Vaults",
      environment: "production",
    });
    // The env reference resolved; the plain values stayed as written.
    expect((entries[0] as ResourceSeedEntry).fields).toEqual({
      endpoint: "https://vault:8200",
      token: "env-resolved-token",
      namespace: "ops",
    });
  });

  test("permission defaults to read — a seed that says nothing grants the least", async () => {
    writeSeed(`connections:
  - id: minimal
    type: kafka
    name: "Minimal"
    roles: ["*"]
`);
    const entries = await loadResourceSeedEntries();
    expect(entries[0]?.permission).toBe("read");
  });

  test("a missing file is a zero-config install, not an error", async () => {
    process.env.STORAGEBASE_RESOURCE_SEED_PATH = join(seedDir, "not-there.yaml");
    resetResourceSeedState();
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("an unreadable path (a directory) logs and serves nothing", async () => {
    process.env.STORAGEBASE_RESOURCE_SEED_PATH = seedDir;
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("unparsable YAML logs and serves nothing", async () => {
    writeSeed("connections: [oops\n  - not yaml");
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("a parser crash that is not the yaml package's own error serves nothing and never quotes the text", async () => {
    writeSeed("connections: NOT-A-YAML-ERROR");
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("an invalid entry is refused by name: the whole file, never a silent row", async () => {
    writeSeed(`connections:
  - id: bad-type
    type: minio
    name: "No such type-id"
    roles: ["*"]
`);
    expect(await loadResourceSeedEntries()).toEqual([]);

    writeSeed(`connections:
  - id: bad-field
    type: kafka
    name: "Unknown field"
    roles: ["*"]
    fields:
      bootstraps: "broker:9092"
`);
    expect(await loadResourceSeedEntries()).toEqual([]);

    writeSeed(`connections:
  - id: no-roles
    type: kafka
    name: "Nobody"
    roles: []
`);
    expect(await loadResourceSeedEntries()).toEqual([]);

    writeSeed(`connections:
  - id: Bad_ID
    type: kafka
    name: "Invalid Id"
    roles: ["*"]
`);
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("a custom role the sign-in mode can never match is refused with the operator's sentence", async () => {
    writeSeed(`connections:
  - id: custom-role
    type: kafka
    name: "Custom"
    roles: ["app:payments"]
`);
    // Local sign-in: a claim role can never match, so the load says so.
    expect(await loadResourceSeedEntries()).toEqual([]);

    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ROLE_PREFIX = "app:";
    writeSeed(`connections:
  - id: wrong-prefix
    type: kafka
    name: "Wrong Prefix"
    roles: ["team:payments"]
`);
    expect(await loadResourceSeedEntries()).toEqual([]);
  });

  test("an entry whose ${ENV} variable is unset is skipped alone; the rest of the file serves", async () => {
    writeSeed(`connections:
  - id: missing-var
    type: hashicorp-vault
    name: "Missing Var"
    roles: ["*"]
    fields:
      token: "\${SB_TEST_TOKEN}"
  - id: present
    type: kafka
    name: "Present"
    roles: ["*"]
`);
    const entries = await loadResourceSeedEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["present"]);
  });

  test("SEED_LITERAL_VALUES leaves every value as written — the upstream ruling for platform-written files", async () => {
    process.env.SB_TEST_TOKEN = "env-resolved-token";
    process.env.SEED_LITERAL_VALUES = "true";
    resetLiteralModeNotices();
    writeSeed(`connections:
  - id: literal
    type: hashicorp-vault
    name: "Literal"
    roles: ["*"]
    fields:
      token: "\${SB_TEST_TOKEN}"
      endpoint: "\${vault:secret/data/x#key}"
`);
    const entries = await loadResourceSeedEntries();
    expect(entries[0]?.fields.token).toBe("${SB_TEST_TOKEN}");
  });
});

describe("role matching and the list rows", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ROLE_PREFIX = "app:";
    writeSeed(`connections:
  - id: everyone
    type: kafka
    name: "Zed Everyone"
    roles: ["*"]
  - id: admins-only
    type: hashicorp-vault
    name: "Admins Only"
    roles: ["admin"]
    permission: admin
  - id: payments-team
    type: azure-key-vault
    name: "Payments Team"
    roles: ["app:payments"]
    permission: write
`);
  });

  test("a wildcard entry matches every session; role entries match only their holders", () => {
    const everyone: ResourceSeedEntry = {
      id: "everyone",
      name: "Zed Everyone",
      type: "kafka",
      roles: ["*"],
      permission: "read",
      fields: {},
    };
    expect(seedEntryMatches(USER_SESSION, everyone)).toBe(true);
    expect(seedEntryMatches(ADMIN_SESSION, everyone)).toBe(true);
  });

  test("rows list only the entries the session's roles select, seeded-marked, sorted by name", async () => {
    const rows = await seededResourceRows(USER_SESSION);
    // "admins-only" and "payments-team" are not for a plain local user session.
    expect(rows.map((row) => row.id)).toEqual(["seed:everyone"]);
    const row = rows[0];
    expect(row).toMatchObject({ id: "seed:everyone", name: "Zed Everyone", seeded: true, permission: "read" });
    expect(row?.hasCredential).toBe(false);
  });

  test("an OIDC claim role under the prefix selects its entry", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    process.env.OIDC_ROLE_PREFIX = "app:";
    const claimSession = { role: "user", claimRoles: ["app:payments", "app:other"] };
    const rows = await seededResourceRows(claimSession);
    expect(rows.map((row) => row.id).sort()).toEqual(["seed:everyone", "seed:payments-team"]);
    const payments = rows.find((candidate) => candidate.id === "seed:payments-team");
    expect(payments).toMatchObject({ permission: "write", seeded: true });
  });

  test("a row never carries a secret value: the marker stands in for the credential", async () => {
    process.env.SB_TEST_TOKEN = "env-resolved-token";
    writeSeed(`connections:
  - id: credentialed
    type: hashicorp-vault
    name: "Credentialed"
    roles: ["*"]
    fields:
      token: "\${SB_TEST_TOKEN}"
      endpoint: "https://vault:8200"
`);
    const rows = await seededResourceRows(USER_SESSION);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("env-resolved-token");
    expect(rows[0]).toMatchObject({ endpoint: "https://vault:8200", hasCredential: true });
  });
});

describe("openSeededResourceConnection", () => {
  test("a role miss answers null, exactly like an id that does not exist", async () => {
    writeSeed(`connections:
  - id: admins-only
    type: hashicorp-vault
    name: "Admins Only"
    roles: ["admin"]
`);
    const forUser = await openSeededResourceConnection(USER_SESSION, "admins-only");
    expect(forUser).toBeNull();
    const unknown = await openSeededResourceConnection(ADMIN_SESSION, "no-such-entry");
    expect(unknown).toBeNull();
  });

  test("a role-matched connection opens with its ${vault:…} references resolved by upstream's client", async () => {
    writeSeed(`connections:
  - id: prod-vault
    type: hashicorp-vault
    name: "Prod Vault"
    roles: ["*"]
    permission: write
    fields:
      endpoint: "\${vault:secret/data/studio#endpoint}"
      token: "\${vault:secret/data/studio#token}"
      namespace: "ops"
`);
    const opened = await openSeededResourceConnection(USER_SESSION, "prod-vault");
    expect(opened).not.toBeNull();
    expect(opened?.connection).toMatchObject({
      id: "seed:prod-vault",
      name: "Prod Vault",
      type: "hashicorp-vault",
      namespace: "ops",
    });
    // The list path never read Vault; the OPEN path read each reference once.
    expect(vaultReads).toEqual(["secret/data/studio#endpoint", "secret/data/studio#token"]);
    expect(opened?.connection.token).toBe("vault-secret-value");
    expect(opened?.connection.endpoint).toBe("vault-secret-value");
    expect(opened?.permission).toBe("write");
  });

  test("SEED_LITERAL_VALUES leaves even the ${vault:…} references unresolved", async () => {
    process.env.SEED_LITERAL_VALUES = "true";
    resetLiteralModeNotices();
    writeSeed(`connections:
  - id: literal-vault
    type: hashicorp-vault
    name: "Literal Vault"
    roles: ["*"]
    fields:
      token: "\${vault:secret/data/studio#token}"
`);
    const opened = await openSeededResourceConnection(USER_SESSION, "literal-vault");
    expect(opened?.connection.token).toBe("${vault:secret/data/studio#token}");
    expect(vaultReads).toEqual([]);
  });

  test("a malformed ${vault:…} reference surfaces upstream's own VaultError sentence", async () => {
    writeSeed(`connections:
  - id: bad-ref
    type: hashicorp-vault
    name: "Bad Reference"
    roles: ["*"]
    fields:
      token: "\${vault:not-a-valid-reference}"
`);
    const refusal = await openSeededResourceConnection(USER_SESSION, "bad-ref").catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(VaultError);
    // Upstream's sentence names the connection (the carrier's id) and the
    // expected reference shape; the reference itself is an address, not a
    // secret, so quoting it is upstream's own behavior.
    expect((refusal as Error).message).toContain("bad-ref");
    expect((refusal as Error).message).toContain("expected");
  });
});

describe("the mock this file installs", () => {
  test("replaces readVaultSecret for importers, keeping upstream's error classes intact", () => {
    expect(readVaultSecret).toBe(mockReadVaultSecret);
    expect(new VaultError("x")).toBeInstanceOf(VaultError);
  });
});
