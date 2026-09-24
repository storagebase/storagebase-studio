import { getForkStore } from "@/lib/fork-store";
import { ResourceConflictError, ResourceConnectionError } from "./errors";
import { compileExclusions, NO_EXCLUSIONS, validateExclusionRules, vaultIdentity } from "./vault-exclusions";
import type { VaultExclusionMatcher, VaultExclusionRule } from "./vault-exclusions";
import type { ResourceConnection } from "./types";

/**
 * Where vault exclusion rules live: the fork's durable settings store
 * (`getForkStore()`), one setting per vault identity. Fail CLOSED: when the
 * store exists but cannot be read, every vault read refuses rather than
 * answering unfiltered — a hiding rule that silently stops hiding is the
 * failure this feature exists to prevent. With `STORAGE_PROVIDER=local` there
 * is no store, so no rule can exist and saving one is refused with the reason.
 */

interface StoredExclusions {
  readonly rules: readonly VaultExclusionRule[];
}

/** The rules stored under one settings key (`vaultIdentity` / `exclusionKey`). */
export async function loadVaultExclusionRules(key: string): Promise<VaultExclusionRule[]> {
  let stored: StoredExclusions | null;
  try {
    const store = await getForkStore();
    if (store === null) return [];
    stored = await store.getSetting<StoredExclusions>(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResourceConnectionError(`Vault exclusion rules could not be read, so the vault is not shown: ${message}`);
  }
  // Re-validated on the way out: a hand-edited row cannot smuggle an unsafe
  // regex past the save-time checks. An invalid row hides nothing silently —
  // it refuses, like an unreadable store.
  try {
    return validateExclusionRules(stored?.rules ?? []);
  } catch (error) {
    throw new ResourceConnectionError(`Stored vault exclusion rules are invalid: ${(error as Error).message}`);
  }
}

export async function loadVaultExclusions(connection: ResourceConnection): Promise<VaultExclusionMatcher> {
  const rules = await loadVaultExclusionRules(vaultIdentity(connection));
  return rules.length === 0 ? NO_EXCLUSIONS : compileExclusions(rules);
}

export async function saveVaultExclusionRules(
  key: string,
  rules: readonly VaultExclusionRule[],
  actor: string,
): Promise<void> {
  const store = await getForkStore();
  if (store === null) {
    throw new ResourceConflictError(
      "Vault exclusion rules need the durable settings store: set STORAGE_PROVIDER to sqlite or postgres",
    );
  }
  await store.setSetting<StoredExclusions>(key, { rules }, actor);
}
