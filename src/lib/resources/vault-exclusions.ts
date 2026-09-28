import { ResourceInvalidRequestError } from "./errors";
import type { VaultObjectType } from "./operations";
import { isResourceType, RESOURCE_CATEGORY_OF, type ResourceConnection, type ResourceType } from "./types";

/**
 * Admin exclusion rules for vault objects (StorageBase fork). One GLOBAL rule
 * list: each rule names which vaults it applies to (a vault type and a pattern
 * over the vault's identity) and which objects it hides there (an object type
 * and a pattern over the object name). Matching objects are hidden from
 * everyone — admins included: admins manage the rules, they do not bypass
 * them. The routes enforce it (src/lib/api/resource-vault-workbench.ts); this
 * module is the pure half: the rule shape, validation, the vault identities
 * a connection is matched by, and matching.
 *
 * THE VAULT IDENTITY IS DERIVED ON THE SERVER from the connection the request
 * actually runs against — for a managed connection, the decrypted record the
 * server resolved — never from anything the browser says about the vault
 * (`vaultIdentities`). The identity follows the provider's own precedence
 * (an Azure `endpoint` wins over `vaultName`, as the provider connects), so a
 * rule matches the vault the call really reaches.
 *
 * Matching is case-insensitive for every kind and both patterns: Key Vault
 * names are, and for a hiding rule the safe error is hiding too much, never
 * too little. Regexes are unanchored (`^…$` anchors them).
 *
 * Regex rules are the dangerous kind (a catastrophic-backtracking pattern
 * evaluated on every listing is a denial of service), so they are held to a
 * restricted grammar at save time — no backreferences, no lookaround, no
 * quantified group that itself contains a quantifier or an alternation — and
 * every evaluated string is bounded. Globs never become regexes at all: they
 * are matched by a linear two-pointer walk.
 */

export type VaultExclusionKind = "exact" | "glob" | "regex";

export type VaultExclusionObjectType = VaultObjectType | "any";

/** A vault resource type-id, or every vault type. */
export type VaultExclusionVaultType = ResourceType | "any";

/** What an administrator writes: the rule without its id and stamps. */
export interface VaultExclusionRuleInput {
  readonly vaultType: VaultExclusionVaultType;
  readonly vaultPattern: string;
  readonly vaultPatternKind: VaultExclusionKind;
  readonly objectPattern: string;
  readonly objectPatternKind: VaultExclusionKind;
  readonly objectType: VaultExclusionObjectType;
  readonly enabled: boolean;
  readonly note: string;
}

/** A stored rule. */
export interface VaultExclusionRule extends VaultExclusionRuleInput {
  readonly id: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** One rule of the per-vault format this replaced; read only to migrate it. */
export interface LegacyVaultExclusionRule {
  readonly pattern: string;
  readonly kind: VaultExclusionKind;
  readonly objectType: VaultExclusionObjectType;
  readonly note: string;
}

export const VAULT_EXCLUSION_MAX_RULES = 500;
const VAULT_EXCLUSION_MAX_LEGACY_RULES = 200;
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

function fields(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requirePattern(where: string, field: string, pattern: unknown, kind: unknown): string {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new ResourceInvalidRequestError(`${where}: "${field}" must be a non-empty string`);
  }
  if (pattern.length > VAULT_EXCLUSION_MAX_PATTERN) {
    throw new ResourceInvalidRequestError(`${where}: patterns are at most ${VAULT_EXCLUSION_MAX_PATTERN} characters`);
  }
  if (kind === "regex") {
    const reason = unsafeRegexReason(pattern);
    if (reason !== null) throw new ResourceInvalidRequestError(`${where}: "${field}" ${reason}`);
  }
  return pattern;
}

function requireKind(where: string, field: string, kind: unknown): VaultExclusionKind {
  if (!KINDS.includes(kind as VaultExclusionKind)) {
    throw new ResourceInvalidRequestError(`${where}: "${field}" must be one of ${KINDS.join(", ")}`);
  }
  return kind as VaultExclusionKind;
}

function requireObjectType(where: string, objectType: unknown): VaultExclusionObjectType {
  if (!OBJECT_TYPES.includes(objectType as VaultExclusionObjectType)) {
    throw new ResourceInvalidRequestError(`${where}: "objectType" must be one of ${OBJECT_TYPES.join(", ")}`);
  }
  return objectType as VaultExclusionObjectType;
}

function requireNote(where: string, note: unknown): string {
  const value = note === undefined ? "" : note;
  if (typeof value !== "string" || value.length > VAULT_EXCLUSION_MAX_NOTE) {
    throw new ResourceInvalidRequestError(`${where}: "note" must be a string of at most ${VAULT_EXCLUSION_MAX_NOTE}`);
  }
  return value;
}

/** Validate one client-supplied rule; throws the first problem as a 400. `enabled` defaults to true. */
export function validateRuleInput(input: unknown, where = "Rule"): VaultExclusionRuleInput {
  const rule = fields(input);
  const vaultType = rule.vaultType;
  if (vaultType !== "any" && !(isResourceType(vaultType) && RESOURCE_CATEGORY_OF[vaultType] === "vault")) {
    throw new ResourceInvalidRequestError(`${where}: "vaultType" must be a vault resource type or "any"`);
  }
  const vaultPatternKind = requireKind(where, "vaultPatternKind", rule.vaultPatternKind);
  const objectPatternKind = requireKind(where, "objectPatternKind", rule.objectPatternKind);
  const enabled = rule.enabled === undefined ? true : rule.enabled;
  if (typeof enabled !== "boolean") throw new ResourceInvalidRequestError(`${where}: "enabled" must be a boolean`);
  return {
    vaultType,
    vaultPattern: requirePattern(where, "vaultPattern", rule.vaultPattern, vaultPatternKind),
    vaultPatternKind,
    objectPattern: requirePattern(where, "objectPattern", rule.objectPattern, objectPatternKind),
    objectPatternKind,
    objectType: requireObjectType(where, rule.objectType),
    enabled,
    note: requireNote(where, rule.note),
  };
}

/** Validate a rule list as stored: every rule input, plus its id and stamps. */
export function validateStoredRules(input: unknown): VaultExclusionRule[] {
  if (!Array.isArray(input)) throw new ResourceInvalidRequestError('"rules" must be an array');
  if (input.length > VAULT_EXCLUSION_MAX_RULES) {
    throw new ResourceInvalidRequestError(`At most ${VAULT_EXCLUSION_MAX_RULES} exclusion rules`);
  }
  return input.map((raw, index) => {
    const where = `Rule ${index + 1}`;
    const rule = fields(raw);
    for (const field of ["id", "updatedBy", "updatedAt"] as const) {
      if (typeof rule[field] !== "string" || rule[field] === "") {
        throw new ResourceInvalidRequestError(`${where}: "${field}" must be a non-empty string`);
      }
    }
    return {
      id: rule.id as string,
      ...validateRuleInput(rule, where),
      updatedBy: rule.updatedBy as string,
      updatedAt: rule.updatedAt as string,
    };
  });
}

/** Validate a per-vault rule list in the format this replaced (the migration's input). */
export function validateLegacyRules(input: unknown): LegacyVaultExclusionRule[] {
  if (!Array.isArray(input)) throw new ResourceInvalidRequestError('"rules" must be an array');
  if (input.length > VAULT_EXCLUSION_MAX_LEGACY_RULES) {
    throw new ResourceInvalidRequestError(`At most ${VAULT_EXCLUSION_MAX_LEGACY_RULES} rules per vault`);
  }
  return input.map((raw, index) => {
    const rule = fields(raw);
    const where = `Rule ${index + 1}`;
    const kind = requireKind(where, "kind", rule.kind);
    return {
      pattern: requirePattern(where, "pattern", rule.pattern, kind),
      kind,
      objectType: requireObjectType(where, rule.objectType),
      note: requireNote(where, rule.note),
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

/** One pattern as a predicate over a lower-cased, bounded value. */
function compilePattern(pattern: string, kind: VaultExclusionKind): (value: string) => boolean {
  const lowered = pattern.toLowerCase();
  if (kind === "exact") return (value) => value === lowered;
  if (kind === "glob") return (value) => globMatches(lowered, value);
  // Regexes were validated at save time, and are re-checked here: one that
  // no longer passes (a hand-edited store) matches EVERYTHING rather than
  // nothing, and is never evaluated.
  const regex = unsafeRegexReason(pattern) === null ? new RegExp(pattern, "i") : null;
  return (value) => regex === null || regex.test(value.slice(0, VAULT_EXCLUSION_MAX_REGEX_NAME));
}

function bounded(value: string): string {
  return value.slice(0, VAULT_EXCLUSION_MAX_NAME).toLowerCase();
}

/** The rules that apply to one vault, compiled: `excludes(type, name)` is the whole enforcement question. */
export interface VaultExclusionMatcher {
  /** How many enabled rules apply to this vault. */
  readonly ruleCount: number;
  excludes(type: VaultObjectType, name: string): boolean;
}

export const NO_EXCLUSIONS: VaultExclusionMatcher = { ruleCount: 0, excludes: () => false };

/** A whole rule list, compiled once, asked per connection. */
export interface CompiledVaultExclusions {
  forConnection(connection: ResourceConnection): VaultExclusionMatcher;
}

export function compileVaultExclusions(rules: readonly VaultExclusionRuleInput[]): CompiledVaultExclusions {
  const compiled = rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      vaultType: rule.vaultType,
      vault: compilePattern(rule.vaultPattern, rule.vaultPatternKind),
      objectType: rule.objectType,
      object: compilePattern(rule.objectPattern, rule.objectPatternKind),
    }));
  return {
    forConnection(connection) {
      if (RESOURCE_CATEGORY_OF[connection.type] !== "vault") return NO_EXCLUSIONS;
      const identities = vaultIdentities(connection).map(bounded);
      const applicable = compiled.filter(
        (rule) =>
          (rule.vaultType === "any" || rule.vaultType === connection.type) &&
          identities.some((identity) => rule.vault(identity)),
      );
      if (applicable.length === 0) return NO_EXCLUSIONS;
      return {
        ruleCount: applicable.length,
        excludes(type, name) {
          const value = bounded(name);
          return applicable.some(
            (rule) => (rule.objectType === "any" || rule.objectType === type) && rule.object(value),
          );
        },
      };
    },
  };
}

// --- The vault identity ---

/** A URL lower-cased, without its trailing slashes or its scheme's default port. */
function normalizeUrl(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/:443$/, "");
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/:#?]/)[0];
  }
}

/**
 * Every string a rule's vault pattern is matched against for this connection,
 * lower-cased; a rule applies when its pattern matches ANY of them. Derived
 * from the connection the server runs against, following each provider's own
 * addressing:
 *
 * - Azure Key Vault: the vault NAME (the first DNS label of the vault host),
 *   the host, and the vault URL. The URL is the `endpoint` when set — the
 *   provider connects there — else `https://<vaultName>.vault.azure.net`.
 * - HashiCorp Vault / OpenBao: the endpoint host, the endpoint URL, and
 *   `<url>#<namespace>` when a namespace is set.
 * - AWS Secrets Manager / KMS: the region, plus the endpoint override URL and
 *   `<region>@<url>` when one is set. The account is not knowable from the
 *   record, so two accounts in one region match alike — the over-hiding
 *   direction, never the leaking one.
 */
export function vaultIdentities(connection: ResourceConnection): string[] {
  const out: string[] = [];
  if (connection.type === "azure-key-vault") {
    const url = normalizeUrl(connection.endpoint || `https://${connection.vaultName ?? ""}.vault.azure.net`);
    const host = hostOf(url);
    out.push(host.split(".")[0], host, url);
  } else if (connection.type === "hashicorp-vault" || connection.type === "openbao") {
    const url = normalizeUrl(connection.endpoint ?? "");
    const namespace = connection.namespace?.trim().toLowerCase();
    out.push(hostOf(url), url, ...(namespace ? [`${url}#${namespace}`] : []));
  } else {
    const region = (connection.region ?? "").trim().toLowerCase();
    out.push(region);
    if (connection.endpoint) {
      const url = normalizeUrl(connection.endpoint);
      out.push(url, `${region}@${url}`);
    }
  }
  return [...new Set(out)];
}
