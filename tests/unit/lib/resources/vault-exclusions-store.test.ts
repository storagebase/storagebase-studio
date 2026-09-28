import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { installAccessStore } from "../../../helpers/access-store";
import { logger } from "@/lib/logger";
import { ResourceConflictError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * The global exclusion list against a REAL fork store (SQLite in memory): the three store states
 * (working, none, throwing — the last one CLOSED), the create/update/delete cycle, the in-process
 * cache and its invalidation, and the one-time migration of the per-vault keys it replaced.
 */

const handle = installAccessStore();

const {
  createVaultExclusionRule,
  deleteVaultExclusionRule,
  invalidateVaultExclusionCache,
  loadVaultExclusionRules,
  loadVaultExclusions,
  setVaultExclusionClockForTest,
  updateVaultExclusionRule,
  vaultExclusionStoreAvailable,
  VAULT_EXCLUSION_CACHE_MS,
  VAULT_EXCLUSIONS_KEY,
} = await import("@/lib/resources/vault-exclusions-store");
const { NO_EXCLUSIONS } = await import("@/lib/resources/vault-exclusions");

const managed: ResourceConnection = {
  id: "managed:team-kv",
  name: "Team vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "kv-prod-app",
};

const RULE = {
  vaultType: "azure-key-vault",
  vaultPattern: "^kv-prod-",
  vaultPatternKind: "regex",
  objectPattern: "break-glass-*",
  objectPatternKind: "glob",
  objectType: "secret",
};

let clock = Date.parse("2026-09-27T10:00:00.000Z");

beforeEach(async () => {
  await handle.reset();
  invalidateVaultExclusionCache();
  clock = Date.parse("2026-09-27T10:00:00.000Z");
  setVaultExclusionClockForTest(() => clock);
});

afterEach(() => setVaultExclusionClockForTest(Date.now));

describe("the global rule list", () => {
  test("create, update and delete round-trip, stamped with who and when", async () => {
    const rule = await createVaultExclusionRule(RULE, "admin");
    expect(rule).toMatchObject({
      ...RULE,
      enabled: true,
      note: "",
      updatedBy: "admin",
      updatedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(await loadVaultExclusionRules()).toEqual([rule]);
    expect((await loadVaultExclusions(managed)).excludes("secret", "break-glass-root")).toBe(true);

    clock += 1000;
    const { before, rule: updated } = await updateVaultExclusionRule(rule.id, { ...RULE, enabled: false }, "other");
    expect(before).toEqual(rule);
    expect(updated).toMatchObject({ id: rule.id, enabled: false, updatedBy: "other" });
    // A save drops the cache: the change applies at once.
    expect(await loadVaultExclusions(managed)).toBe(NO_EXCLUSIONS);

    expect(await deleteVaultExclusionRule(rule.id, "admin")).toEqual(updated);
    expect(await loadVaultExclusionRules()).toEqual([]);
  });

  test("unknown ids are 404s, invalid input 400s, and the list is bounded", async () => {
    expect(await updateVaultExclusionRule("nope", RULE, "a").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(await deleteVaultExclusionRule("nope", "a").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
    const invalid = await createVaultExclusionRule({ ...RULE, vaultPattern: "(a+)+" }, "a").catch((e: unknown) => e);
    expect((invalid as Error).message).toContain("repeated group");

    const full = Array.from({ length: 500 }, (_, index) => ({
      id: `r${index}`,
      ...RULE,
      enabled: true,
      note: "",
      updatedBy: "a",
      updatedAt: "t",
    }));
    await handle.store.setSetting(VAULT_EXCLUSIONS_KEY, { version: 1, rules: full }, "a");
    expect(await createVaultExclusionRule(RULE, "a").catch((e: unknown) => e)).toBeInstanceOf(ResourceConflictError);
  });

  test("the compiled list is cached for at most the window, then read again", async () => {
    await createVaultExclusionRule(RULE, "admin");
    expect((await loadVaultExclusions(managed)).ruleCount).toBe(1);
    // A write behind the module's back (another replica) is seen once the window passes.
    await handle.store.setSetting(VAULT_EXCLUSIONS_KEY, { version: 1, rules: [] }, "elsewhere");
    expect((await loadVaultExclusions(managed)).ruleCount).toBe(1);
    clock += VAULT_EXCLUSION_CACHE_MS;
    expect(await loadVaultExclusions(managed)).toBe(NO_EXCLUSIONS);
  });

  test("no store: nothing is hidden and saving is refused with the reason", async () => {
    handle.mode = "none";
    expect(await loadVaultExclusionRules()).toEqual([]);
    expect(await vaultExclusionStoreAvailable()).toBe(false);
    const error = await createVaultExclusionRule(RULE, "admin").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConflictError);
    expect((error as Error).message).toContain("STORAGE_PROVIDER");
  });

  test("an unreadable store or an invalid stored row fails CLOSED", async () => {
    handle.mode = "broken";
    const broken = await loadVaultExclusions(managed).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(ResourceConnectionError);
    expect((broken as Error).message).toContain("database is locked");

    handle.mode = "store";
    await handle.store.setSetting(VAULT_EXCLUSIONS_KEY, { version: 1, rules: [{ ...RULE, id: "x" }] }, "hand");
    const invalid = await loadVaultExclusions(managed).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(ResourceConnectionError);
    expect((invalid as Error).message).toContain("invalid");

    const failing = spyOn(handle.store, "getSetting").mockImplementationOnce(async () => {
      throw "plain failure";
    });
    expect(((await loadVaultExclusionRules().catch((e: unknown) => e)) as Error).message).toContain("plain failure");
    failing.mockRestore();
  });
});

describe("migrating the per-vault keys", () => {
  const legacy = (pattern: string, objectType = "any") => ({ pattern, kind: "glob", objectType, note: "kept" });

  test("folds real vaults into exact global rules, drops the empty-vault keys with a warning, once", async () => {
    await handle.store.setSetting(
      "vault-exclusions:azure-key-vault:https://kv-prod-app.vault.azure.net",
      { rules: [legacy("hidden-*", "secret"), legacy("old-*")] },
      "admin",
    );
    // The bogus key a managed connection's browser-computed address produced.
    await handle.store.setSetting(
      "vault-exclusions:azure-key-vault:https://.vault.azure.net",
      { rules: [legacy("*")] },
      "admin",
    );
    await handle.store.setSetting("vault-exclusions:hashicorp-vault:#team-a", { rules: [legacy("*")] }, "admin");
    await handle.store.setSetting("vault-exclusions:aws-kms:default", { rules: [legacy("*")] }, "admin");
    await handle.store.setSetting("vault-exclusions:aws-kms:", { rules: [legacy("*")] }, "admin");
    await handle.store.setSetting("vault-exclusions:s3:bucket", { rules: [legacy("*")] }, "admin");
    await handle.store.setSetting("vault-exclusions:openbao", { rules: [] }, "admin");
    await handle.store.setSetting("vault-exclusions:aws-secrets-manager:eu-west-1", {}, "admin");
    await handle.store.setSetting(
      "vault-exclusions:openbao:http://bao.test:8200#team-a",
      { rules: [legacy("x", "key")] },
      "admin",
    );
    const warned = spyOn(logger, "warn").mockImplementation(() => {});
    const informed = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const rules = await loadVaultExclusionRules();
      expect(
        rules.map((rule) => [rule.vaultType, rule.vaultPattern, rule.vaultPatternKind, rule.objectPattern]),
      ).toEqual([
        ["azure-key-vault", "https://kv-prod-app.vault.azure.net", "exact", "hidden-*"],
        ["azure-key-vault", "https://kv-prod-app.vault.azure.net", "exact", "old-*"],
        ["openbao", "http://bao.test:8200#team-a", "exact", "x"],
      ]);
      expect(rules[0]).toMatchObject({ objectType: "secret", enabled: true, note: "kept", updatedBy: "migration" });
      expect(rules[0].id).toMatch(/^legacy-[0-9a-f]{16}$/);
      const droppedKeys = warned.mock.calls.map((call) => (call[1] as { key: string }).key);
      expect(droppedKeys).toEqual([
        "vault-exclusions:aws-kms:",
        "vault-exclusions:aws-kms:default",
        "vault-exclusions:azure-key-vault:https://.vault.azure.net",
        "vault-exclusions:hashicorp-vault:#team-a",
        "vault-exclusions:openbao",
        "vault-exclusions:s3:bucket",
      ]);
      expect(informed).toHaveBeenCalledTimes(1);

      // The migrated rule applies to the real vault (a managed connection resolved on the server).
      expect((await loadVaultExclusions(managed)).excludes("secret", "hidden-x")).toBe(true);

      // Idempotent: the global setting now exists, so a second read migrates nothing again.
      await handle.store.setSetting(
        "vault-exclusions:azure-key-vault:https://late.vault.azure.net",
        { rules: [legacy("*")] },
        "admin",
      );
      invalidateVaultExclusionCache();
      expect((await loadVaultExclusionRules()).map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
      expect(informed).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
      informed.mockRestore();
    }
  });

  test("two migrations of the same keys agree on every id", async () => {
    await handle.store.setSetting("vault-exclusions:aws-kms:eu-west-1", { rules: [legacy("k-*", "key")] }, "admin");
    const first = await loadVaultExclusionRules();
    await handle.reset();
    await handle.store.setSetting("vault-exclusions:aws-kms:eu-west-1", { rules: [legacy("k-*", "key")] }, "admin");
    expect(await loadVaultExclusionRules()).toEqual(first);
  });

  test("with nothing to migrate, nothing is written", async () => {
    expect(await loadVaultExclusionRules()).toEqual([]);
    expect(await handle.store.getSetting(VAULT_EXCLUSIONS_KEY)).toBeNull();
  });

  test("an invalid legacy row fails CLOSED, naming its key", async () => {
    await handle.store.setSetting(
      "vault-exclusions:azure-key-vault:https://kv.vault.azure.net",
      { rules: [{ pattern: "(a+)+", kind: "regex", objectType: "any" }] },
      "hand",
    );
    const error = await loadVaultExclusions(managed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConnectionError);
    expect((error as Error).message).toContain("https://kv.vault.azure.net");
  });
});
