import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ResourceConflictError, ResourceConnectionError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * The durable store behind vault exclusion rules is doubled at the fork-store
 * seam: getForkStore answers null (STORAGE_PROVIDER=local), a working store,
 * or throws — the three states the loader must handle, the last one CLOSED.
 */

const settings = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; actor: string }> = [];
let mode: "store" | "none" | "broken" = "store";

const store = {
  getSetting: async (key: string) => (settings.has(key) ? settings.get(key) : null),
  setSetting: async (key: string, value: unknown, actor: string) => {
    setCalls.push({ key, value, actor });
    settings.set(key, value);
  },
};

mock.module("@/lib/fork-store", () => ({
  getForkStore: mock(async () => {
    if (mode === "broken") throw new Error("database is locked");
    return mode === "none" ? null : store;
  }),
}));

const { loadVaultExclusionRules, loadVaultExclusions, saveVaultExclusionRules } = await import(
  "@/lib/resources/vault-exclusions-store"
);
const { NO_EXCLUSIONS, vaultIdentity } = await import("@/lib/resources/vault-exclusions");

const connection: ResourceConnection = {
  id: "r",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "example",
};
const key = vaultIdentity(connection);

describe("vault exclusion store", () => {
  beforeEach(() => {
    settings.clear();
    setCalls.length = 0;
    mode = "store";
  });

  test("saves under the vault identity and reads back a compiled matcher", async () => {
    await saveVaultExclusionRules(key, [{ pattern: "db-*", kind: "glob", objectType: "secret", note: "" }], "admin");
    expect(setCalls[0]).toMatchObject({
      key: "vault-exclusions:azure-key-vault:https://example.vault.azure.net",
      actor: "admin",
    });
    const matcher = await loadVaultExclusions(connection);
    expect(matcher.excludes("secret", "db-password")).toBe(true);
    expect(await loadVaultExclusionRules(key)).toHaveLength(1);
  });

  test("no rules, and no store at all, both mean nothing is hidden", async () => {
    expect(await loadVaultExclusions(connection)).toBe(NO_EXCLUSIONS);
    mode = "none";
    expect(await loadVaultExclusionRules(key)).toEqual([]);
  });

  test("saving without a durable store is refused with the reason", async () => {
    mode = "none";
    const error = await saveVaultExclusionRules(key, [], "admin").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConflictError);
    expect((error as Error).message).toContain("STORAGE_PROVIDER");
  });

  test("an unreadable store or an invalid stored row fails CLOSED", async () => {
    mode = "broken";
    const broken = await loadVaultExclusions(connection).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(ResourceConnectionError);
    expect((broken as Error).message).toContain("database is locked");

    mode = "store";
    settings.set(key, { rules: [{ pattern: "(a+)+", kind: "regex", objectType: "any" }] });
    const invalid = await loadVaultExclusions(connection).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ResourceConnectionError);
    expect((invalid as Error).message).toContain("invalid");

    mode = "broken";
    const { getForkStore } = await import("@/lib/fork-store");
    (getForkStore as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw "plain failure";
    });
    expect(((await loadVaultExclusions(connection).catch((e: unknown) => e)) as Error).message).toContain(
      "plain failure",
    );
  });
});
