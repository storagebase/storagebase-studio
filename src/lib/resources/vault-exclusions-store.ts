import { createHash, randomUUID } from "node:crypto";
import { getForkStore } from "@/lib/fork-store";
import type { ForkStore } from "@/lib/fork-store/types";
import { logger } from "@/lib/logger";
import { ResourceConflictError, ResourceConnectionError, ResourceNotFoundError } from "./errors";
import {
  compileVaultExclusions,
  NO_EXCLUSIONS,
  validateLegacyRules,
  validateRuleInput,
  validateStoredRules,
  VAULT_EXCLUSION_MAX_RULES,
} from "./vault-exclusions";
import type { CompiledVaultExclusions, VaultExclusionMatcher, VaultExclusionRule } from "./vault-exclusions";
import { isResourceType, RESOURCE_CATEGORY_OF, type ResourceConnection } from "./types";

/**
 * Where vault exclusion rules live: ONE setting in the fork's durable settings
 * store (`getForkStore()`), `vault-exclusions:global`, holding every rule.
 * Every vault request compiles the enabled rules whose vault matcher matches
 * the connection it runs against (src/lib/resources/vault-exclusions.ts).
 *
 * Fail CLOSED: when the store exists but cannot be read, or a stored rule is
 * invalid, every vault read refuses rather than answering unfiltered — a
 * hiding rule that silently stops hiding is the failure this feature exists
 * to prevent. With `STORAGE_PROVIDER=local` there is no store, so no rule can
 * exist and saving one is refused with the reason.
 *
 * The compiled list is cached in-process for at most `VAULT_EXCLUSION_CACHE_MS`
 * and dropped on every save here, so a change applies at once on this replica
 * and within the window on the others.
 *
 * MIGRATION. Rules used to be stored per vault, as `vault-exclusions:<type>:<address>`
 * keyed by an address the browser computed. While the global setting does not
 * exist yet, a read folds every such key into global rules — vault type = the
 * key's type, vault pattern = the address, exact — and writes the global
 * setting, which ends the migration (idempotent: it never runs twice, and two
 * replicas racing it write the same rules under the same ids). A key whose
 * vault part is empty (the `https://.vault.azure.net` one the browser saved
 * for managed connections, whose vault name it never had) applied to no real
 * vault, so it is dropped with a warning. The old keys stay in the table,
 * unread, as the record of what was migrated.
 */

export const VAULT_EXCLUSIONS_KEY = "vault-exclusions:global";
const LEGACY_PREFIX = "vault-exclusions:";
export const VAULT_EXCLUSION_CACHE_MS = 10_000;

const STORE_REQUIRED =
  "Vault exclusion rules need the durable settings store: set STORAGE_PROVIDER to sqlite or postgres";

interface StoredExclusions {
  readonly version: 1;
  readonly rules: readonly VaultExclusionRule[];
}

let now: () => number = Date.now;
let cached: { at: number; compiled: CompiledVaultExclusions } | null = null;

/** Tests only: the cache clock. */
export function setVaultExclusionClockForTest(clock: () => number): void {
  now = clock;
}

export function invalidateVaultExclusionCache(): void {
  cached = null;
}

/** The empty-vault test for a legacy key's address: a key that could never have matched a real vault. */
function legacyVaultIsEmpty(type: string, address: string): boolean {
  if (address === "") return true;
  if (type === "azure-key-vault") return /^[a-z]+:\/\/\./.test(address);
  if (type === "hashicorp-vault" || type === "openbao") return address.startsWith("#");
  // AWS: the old key used "default" for a missing region, which the providers refuse to connect without.
  return address === "default" || address.startsWith("default@");
}

async function migrateLegacy(store: ForkStore): Promise<VaultExclusionRule[]> {
  const rows = await store.listSettings<{ rules?: unknown }>(LEGACY_PREFIX);
  const rules: VaultExclusionRule[] = [];
  const migratedAt = new Date(now()).toISOString();
  for (const { key, value } of rows) {
    if (key === VAULT_EXCLUSIONS_KEY) continue;
    const rest = key.slice(LEGACY_PREFIX.length);
    const split = rest.indexOf(":");
    const type = split === -1 ? rest : rest.slice(0, split);
    const address = split === -1 ? "" : rest.slice(split + 1).trim();
    if (!isResourceType(type) || RESOURCE_CATEGORY_OF[type] !== "vault" || legacyVaultIsEmpty(type, address)) {
      logger.warn("Dropping a per-vault exclusion key with no vault: it matched no real vault", {
        route: "vault-exclusions",
        key,
      });
      continue;
    }
    let legacy;
    try {
      legacy = validateLegacyRules(value?.rules ?? []);
    } catch (error) {
      throw new ResourceConnectionError(
        `Stored vault exclusion rules under "${key}" are invalid and could not be migrated: ${(error as Error).message}`,
      );
    }
    legacy.forEach((rule, index) => {
      rules.push({
        id: `legacy-${createHash("sha256").update(`${key}\n${index}`).digest("hex").slice(0, 16)}`,
        vaultType: type,
        vaultPattern: address,
        vaultPatternKind: "exact",
        objectPattern: rule.pattern,
        objectPatternKind: rule.kind,
        objectType: rule.objectType,
        enabled: true,
        note: rule.note,
        updatedBy: "migration",
        updatedAt: migratedAt,
      });
    });
  }
  if (rules.length > 0) {
    await store.setSetting<StoredExclusions>(VAULT_EXCLUSIONS_KEY, { version: 1, rules }, "migration");
    logger.info("Migrated per-vault exclusion rules to the global list", {
      route: "vault-exclusions",
      rules: rules.length,
    });
  }
  return rules;
}

async function readRules(store: ForkStore): Promise<VaultExclusionRule[]> {
  const stored = await store.getSetting<StoredExclusions>(VAULT_EXCLUSIONS_KEY);
  if (stored === null) return migrateLegacy(store);
  // Re-validated on the way out: a hand-edited row cannot smuggle an unsafe
  // regex past the save-time checks. An invalid row hides nothing silently —
  // it refuses, like an unreadable store.
  try {
    return validateStoredRules(stored.rules);
  } catch (error) {
    throw new ResourceConnectionError(`Stored vault exclusion rules are invalid: ${(error as Error).message}`);
  }
}

/** Every rule, uncached (the admin list). An empty list when the deployment has no durable store. */
export async function loadVaultExclusionRules(): Promise<VaultExclusionRule[]> {
  let store: ForkStore | null;
  try {
    store = await getForkStore();
    if (store === null) return [];
    return await readRules(store);
  } catch (error) {
    if (error instanceof ResourceConnectionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ResourceConnectionError(`Vault exclusion rules could not be read, so the vault is not shown: ${message}`);
  }
}

async function compiledRules(): Promise<CompiledVaultExclusions> {
  if (cached !== null && now() - cached.at < VAULT_EXCLUSION_CACHE_MS) return cached.compiled;
  const compiled = compileVaultExclusions(await loadVaultExclusionRules());
  cached = { at: now(), compiled };
  return compiled;
}

/** The enforcement question for one request: the enabled rules that apply to this connection's vault. */
export async function loadVaultExclusions(connection: ResourceConnection): Promise<VaultExclusionMatcher> {
  const matcher = (await compiledRules()).forConnection(connection);
  return matcher.ruleCount === 0 ? NO_EXCLUSIONS : matcher;
}

async function requireStore(): Promise<ForkStore> {
  const store = await getForkStore();
  if (store === null) throw new ResourceConflictError(STORE_REQUIRED);
  return store;
}

async function writeRules(store: ForkStore, rules: VaultExclusionRule[], actor: string): Promise<void> {
  await store.setSetting<StoredExclusions>(VAULT_EXCLUSIONS_KEY, { version: 1, rules }, actor);
  invalidateVaultExclusionCache();
}

function stamped(id: string, input: unknown, actor: string): VaultExclusionRule {
  return { id, ...validateRuleInput(input), updatedBy: actor, updatedAt: new Date(now()).toISOString() };
}

export async function createVaultExclusionRule(input: unknown, actor: string): Promise<VaultExclusionRule> {
  const store = await requireStore();
  const rules = await readRules(store);
  if (rules.length >= VAULT_EXCLUSION_MAX_RULES) {
    throw new ResourceConflictError(`At most ${VAULT_EXCLUSION_MAX_RULES} exclusion rules`);
  }
  const rule = stamped(randomUUID(), input, actor);
  await writeRules(store, [...rules, rule], actor);
  return rule;
}

export async function updateVaultExclusionRule(
  id: string,
  input: unknown,
  actor: string,
): Promise<{ before: VaultExclusionRule; rule: VaultExclusionRule }> {
  const store = await requireStore();
  const rules = await readRules(store);
  const before = rules.find((candidate) => candidate.id === id);
  if (before === undefined) throw new ResourceNotFoundError(`Exclusion rule "${id}" does not exist`);
  const rule = stamped(id, input, actor);
  await writeRules(
    store,
    rules.map((candidate) => (candidate.id === id ? rule : candidate)),
    actor,
  );
  return { before, rule };
}

export async function deleteVaultExclusionRule(id: string, actor: string): Promise<VaultExclusionRule> {
  const store = await requireStore();
  const rules = await readRules(store);
  const before = rules.find((candidate) => candidate.id === id);
  if (before === undefined) throw new ResourceNotFoundError(`Exclusion rule "${id}" does not exist`);
  await writeRules(
    store,
    rules.filter((candidate) => candidate.id !== id),
    actor,
  );
  return before;
}

/** Whether rules can be saved here at all (the admin screen's notice). */
export async function vaultExclusionStoreAvailable(): Promise<boolean> {
  return (await getForkStore()) !== null;
}
