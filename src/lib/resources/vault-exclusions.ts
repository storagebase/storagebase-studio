import { ResourceInvalidRequestError } from "./errors";
import type { VaultObjectType } from "./operations";
import type { ResourceConnection } from "./types";

/**
 * Admin exclusion rules for vault objects (StorageBase fork). A rule hides
 * matching secrets / keys / certificates of ONE vault from everyone —
 * admins included: admins manage the rules, they do not bypass them. The
 * routes enforce it (src/lib/api/resource-vault-workbench.ts); this module is
 * the pure half: the rule shape, validation, the vault identity the rules are
 * keyed by, and matching.
 *
 * Matching is case-insensitive for every kind: Key Vault names are, and for
 * a hiding rule the safe error is hiding too much, never too little.
 *
 * Regex rules are the dangerous kind (a catastrophic-backtracking pattern
 * evaluated on every listing is a denial of service), so they are held to a
 * restricted grammar at save time — no backreferences, no lookaround, no
 * quantified group that itself contains a quantifier or an alternation — and
 * every evaluated name is bounded. Globs never become regexes at all: they
 * are matched by a linear two-pointer walk.
 */

export type VaultExclusionKind = "exact" | "glob" | "regex";

export type VaultExclusionObjectType = VaultObjectType | "any";

export interface VaultExclusionRule {
  readonly pattern: string;
  readonly kind: VaultExclusionKind;
  readonly objectType: VaultExclusionObjectType;
  readonly note: string;
}

export const VAULT_EXCLUSION_MAX_RULES = 200;
const VAULT_EXCLUSION_MAX_PATTERN = 200;
const VAULT_EXCLUSION_MAX_NOTE = 500;
/** Names are cut to this before matching: bounds every evaluation, whatever the service allows. */
export const VAULT_EXCLUSION_MAX_NAME = 1024;
/** Regexes see at most this much of a name: with two unbounded quantifiers, O(n^2) on 256 chars. */
export const VAULT_EXCLUSION_MAX_REGEX_NAME = 256;
/** Unbounded quantifiers (`*`, `+`, `{n,}`) one regex may hold: overlapping ones cost O(n^k). */
const VAULT_EXCLUSION_MAX_UNBOUNDED = 2;

const KINDS: readonly VaultExclusionKind[] = ["exact", "glob", "regex"];
const OBJECT_TYPES: readonly VaultExclusionObjectType[] = ["secret", "key", "certificate", "any"];

/**
 * Why a regex is refused, or null when it is inside the safe grammar. The
 * checks are syntactic and conservative: some harmless patterns are refused
 * too, which the sentence says, and exact/glob rules cover those cases.
 */
export function unsafeRegexReason(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return "backreferences are not allowed";
  if (/\(\?<?[=!]/.test(pattern)) return "lookahead and lookbehind are not allowed";
  // A group followed by a quantifier, whose body holds a quantifier or an
  // alternation: the nested-repetition shape behind catastrophic backtracking.
  const stack: number[] = [];
  let unbounded = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      // Skip a character class whole: its metacharacters are literals.
      const close = pattern.indexOf("]", index + 2);
      index = close === -1 ? pattern.length : close;
      continue;
    }
    if (char === "*" || char === "+" || (char === "{" && /^\{\d+,\}/.test(pattern.slice(index)))) unbounded += 1;
    if (char === "(") stack.push(index);
    if (char === ")" && stack.length > 0) {
      const open = stack.pop() as number;
      const next = pattern[index + 1];
      if (next === "*" || next === "+" || next === "?" || next === "{") {
        const body = pattern.slice(open + 1, index).replace(/\\./g, "");
        if (/[*+?{|]/.test(body)) return "a repeated group may not contain a repetition or an alternation";
      }
    }
  }
  if (unbounded > VAULT_EXCLUSION_MAX_UNBOUNDED) {
    return `at most ${VAULT_EXCLUSION_MAX_UNBOUNDED} unbounded repetitions (*, +, {n,}) per pattern`;
  }
  try {
    RegExp(pattern, "i");
  } catch (error) {
    return `not a valid regular expression (${(error as Error).message})`;
  }
  return null;
}

/** Validate a client-supplied rule list; throws the first problem as a 400. */
export function validateExclusionRules(input: unknown): VaultExclusionRule[] {
  if (!Array.isArray(input)) throw new ResourceInvalidRequestError('"rules" must be an array');
  if (input.length > VAULT_EXCLUSION_MAX_RULES) {
    throw new ResourceInvalidRequestError(`At most ${VAULT_EXCLUSION_MAX_RULES} rules per vault`);
  }
  return input.map((raw, index) => {
    const rule = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const where = `Rule ${index + 1}`;
    if (typeof rule.pattern !== "string" || rule.pattern.trim() === "") {
      throw new ResourceInvalidRequestError(`${where}: "pattern" must be a non-empty string`);
    }
    if (rule.pattern.length > VAULT_EXCLUSION_MAX_PATTERN) {
      throw new ResourceInvalidRequestError(`${where}: patterns are at most ${VAULT_EXCLUSION_MAX_PATTERN} characters`);
    }
    if (!KINDS.includes(rule.kind as VaultExclusionKind)) {
      throw new ResourceInvalidRequestError(`${where}: "kind" must be one of ${KINDS.join(", ")}`);
    }
    if (!OBJECT_TYPES.includes(rule.objectType as VaultExclusionObjectType)) {
      throw new ResourceInvalidRequestError(`${where}: "objectType" must be one of ${OBJECT_TYPES.join(", ")}`);
    }
    const note = rule.note === undefined ? "" : rule.note;
    if (typeof note !== "string" || note.length > VAULT_EXCLUSION_MAX_NOTE) {
      throw new ResourceInvalidRequestError(`${where}: "note" must be a string of at most ${VAULT_EXCLUSION_MAX_NOTE}`);
    }
    if (rule.kind === "regex") {
      const reason = unsafeRegexReason(rule.pattern);
      if (reason !== null) throw new ResourceInvalidRequestError(`${where}: ${reason}`);
    }
    return {
      pattern: rule.pattern,
      kind: rule.kind as VaultExclusionKind,
      objectType: rule.objectType as VaultExclusionObjectType,
      note,
    };
  });
}

/**
 * Wildcard match (`*` any run, `?` one character), linear-time two-pointer
 * walk with single-star backtracking — no regex, so no pattern can make it
 * explode. Both sides arrive lower-cased.
 */
export function globMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = n;
      p += 1;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** A compiled rule set for one vault: `excludes(type, name)` is the whole enforcement question. */
export interface VaultExclusionMatcher {
  readonly rules: readonly VaultExclusionRule[];
  excludes(type: VaultObjectType, name: string): boolean;
}

export function compileExclusions(rules: readonly VaultExclusionRule[]): VaultExclusionMatcher {
  const compiled = rules.map((rule) => {
    const pattern = rule.pattern.toLowerCase();
    // Regexes were validated at save time, and are re-checked here: one that
    // no longer passes (a hand-edited store) hides EVERYTHING of its type
    // rather than nothing, and is never evaluated.
    const regex =
      rule.kind === "regex" && unsafeRegexReason(rule.pattern) === null ? new RegExp(rule.pattern, "i") : null;
    const matches = (name: string) => {
      if (rule.kind === "exact") return name === pattern;
      if (rule.kind === "glob") return globMatches(pattern, name);
      return regex === null || regex.test(name.slice(0, VAULT_EXCLUSION_MAX_REGEX_NAME));
    };
    return { objectType: rule.objectType, matches };
  });
  return {
    rules,
    excludes(type, name) {
      const bounded = name.slice(0, VAULT_EXCLUSION_MAX_NAME).toLowerCase();
      return compiled.some((rule) => (rule.objectType === "any" || rule.objectType === type) && rule.matches(bounded));
    },
  };
}

export const NO_EXCLUSIONS: VaultExclusionMatcher = compileExclusions([]);

/**
 * The vault a rule set belongs to, as the settings key: type plus the
 * normalized address, so two saved connections to the same vault share one
 * rule set and a renamed connection keeps it.
 */
export function vaultIdentity(connection: ResourceConnection): string {
  return exclusionKey(connection.type, normalizedVaultAddress(connection));
}

/** The settings key for a vault type + normalized address (what the admin API is addressed by). */
export function exclusionKey(type: string, address: string): string {
  return `vault-exclusions:${type}:${address.trim().toLowerCase()}`;
}

export function normalizedVaultAddress(connection: ResourceConnection): string {
  const url = (value: string) => value.trim().toLowerCase().replace(/\/+$/, "").replace(/:443$/, "");
  if (connection.type === "azure-key-vault") {
    return url(connection.endpoint || `https://${connection.vaultName ?? ""}.vault.azure.net`);
  }
  if (connection.type === "hashicorp-vault" || connection.type === "openbao") {
    const namespace = connection.namespace?.trim();
    return `${url(connection.endpoint ?? "")}${namespace ? `#${namespace.toLowerCase()}` : ""}`;
  }
  // AWS: the account is not knowable from the record, so rules key on region
  // (+ endpoint override). Two accounts in one region share rules — the
  // over-hiding direction, never the leaking one.
  const region = (connection.region ?? "default").trim().toLowerCase();
  return connection.endpoint ? `${region}@${url(connection.endpoint)}` : region;
}
