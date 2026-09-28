import { describe, test, expect } from "bun:test";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import {
  compileVaultExclusions,
  globMatches,
  NO_EXCLUSIONS,
  unsafeRegexReason,
  validateLegacyRules,
  validateRuleInput,
  validateStoredRules,
  vaultIdentities,
  VAULT_EXCLUSION_MAX_NAME,
  VAULT_EXCLUSION_MAX_REGEX_NAME,
  VAULT_EXCLUSION_MAX_RULES,
  type VaultExclusionRuleInput,
} from "@/lib/resources/vault-exclusions";
import type { ResourceConnection } from "@/lib/resources/types";

const base = { id: "r", name: "n", createdAt: "2026-01-01T00:00:00.000Z" };
const azure = { ...base, type: "azure-key-vault", vaultName: "kv-prod-app" } as ResourceConnection;

function rule(overrides: Partial<VaultExclusionRuleInput> = {}): VaultExclusionRuleInput {
  return {
    vaultType: "any",
    vaultPattern: "*",
    vaultPatternKind: "glob",
    objectPattern: "*",
    objectPatternKind: "glob",
    objectType: "any",
    enabled: true,
    note: "",
    ...overrides,
  };
}

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("rule validation", () => {
  test("accepts a full rule, defaulting enabled and note", () => {
    const { enabled: _enabled, note: _note, ...bare } = rule({ vaultType: "azure-key-vault" });
    expect(validateRuleInput(bare)).toEqual(rule({ vaultType: "azure-key-vault" }));
    expect(validateRuleInput(rule({ enabled: false, note: "why" }))).toEqual(rule({ enabled: false, note: "why" }));
  });

  test("refuses every malformed field with the sentence that names it", () => {
    const cases: Array<[unknown, string]> = [
      [null, '"vaultType"'],
      [[rule()], '"vaultType"'],
      [rule({ vaultType: "s3" as never }), '"vaultType"'],
      [rule({ vaultType: "nope" as never }), '"vaultType"'],
      [rule({ vaultPatternKind: "fuzzy" as never }), '"vaultPatternKind"'],
      [rule({ objectPatternKind: "fuzzy" as never }), '"objectPatternKind"'],
      [rule({ enabled: "yes" as never }), '"enabled"'],
      [rule({ vaultPattern: " " }), '"vaultPattern" must be a non-empty string'],
      [rule({ objectPattern: 5 as never }), '"objectPattern" must be a non-empty string'],
      [rule({ objectPattern: "x".repeat(201) }), "at most 200"],
      [rule({ vaultPattern: "(a+)+", vaultPatternKind: "regex" }), '"vaultPattern" a repeated group'],
      [rule({ objectPattern: "(\\w)\\1", objectPatternKind: "regex" }), '"objectPattern" backreferences'],
      [rule({ objectType: "blob" as never }), '"objectType"'],
      [rule({ note: 5 as never }), '"note"'],
    ];
    for (const [input, sentence] of cases) {
      const error = thrown(() => validateRuleInput(input));
      expect(error).toBeInstanceOf(ResourceInvalidRequestError);
      expect(error.message).toContain(sentence);
    }
    expect(thrown(() => validateRuleInput(null, "Rule 3")).message).toStartWith("Rule 3:");
  });

  test("stored lists need an array, a bound, and each rule's id and stamps", () => {
    const stored = { id: "a", ...rule(), updatedBy: "admin", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(validateStoredRules([stored])).toEqual([stored]);
    expect(thrown(() => validateStoredRules("x")).message).toContain("must be an array");
    expect(thrown(() => validateStoredRules(Array.from({ length: VAULT_EXCLUSION_MAX_RULES + 1 }))).message).toContain(
      "At most",
    );
    expect(thrown(() => validateStoredRules([{ ...stored, id: "" }])).message).toContain('Rule 1: "id"');
    expect(thrown(() => validateStoredRules([{ ...stored, updatedAt: 1 }])).message).toContain('"updatedAt"');
    expect(thrown(() => validateStoredRules([{ ...stored, objectType: "x" }])).message).toContain("Rule 1:");
  });

  test("the legacy per-vault format validates as it did", () => {
    expect(validateLegacyRules([{ pattern: "db-*", kind: "glob", objectType: "secret" }])).toEqual([
      { pattern: "db-*", kind: "glob", objectType: "secret", note: "" },
    ]);
    expect(thrown(() => validateLegacyRules("x")).message).toContain("must be an array");
    expect(thrown(() => validateLegacyRules(Array.from({ length: 201 }))).message).toContain("per vault");
    expect(
      thrown(() => validateLegacyRules([{ pattern: "(a+)+", kind: "regex", objectType: "any" }])).message,
    ).toContain("repeated group");
  });
});

describe("the regex grammar and globs", () => {
  test("the regex grammar refuses the catastrophic shapes and invalid syntax", () => {
    expect(unsafeRegexReason("(\\w)\\1")).toContain("backreferences");
    expect(unsafeRegexReason("(?<n>a)\\k<n>")).toContain("backreferences");
    expect(unsafeRegexReason("a(?=b)")).toContain("lookahead");
    expect(unsafeRegexReason("(?<!a)b")).toContain("lookahead");
    expect(unsafeRegexReason("(a|aa)*")).toContain("repeated group");
    expect(unsafeRegexReason("(?:ab+){2,}")).toContain("repeated group");
    expect(unsafeRegexReason("a*b*c*")).toContain("unbounded repetitions");
    expect(unsafeRegexReason("a{2,}b+c*")).toContain("unbounded repetitions");
    expect(unsafeRegexReason("(unclosed")).toContain("not a valid regular expression");
    expect(unsafeRegexReason("(ab)+")).toBeNull();
    expect(unsafeRegexReason("[(*+|]x\\(y\\)")).toBeNull();
    expect(unsafeRegexReason("[abc")).not.toBeNull();
    expect(unsafeRegexReason("a{2,3}b")).toBeNull();
    expect(unsafeRegexReason("x)")).not.toBeNull();
  });

  test("globs match * and ? without regexes, anchored at both ends", () => {
    expect(globMatches("db-*", "db-password")).toBe(true);
    expect(globMatches("db-*", "prod-db-password")).toBe(false);
    expect(globMatches("*-key", "signing-key")).toBe(true);
    expect(globMatches("a?c", "abc")).toBe(true);
    expect(globMatches("a?c", "ac")).toBe(false);
    expect(globMatches("*a*b*", "xxaxxbxx")).toBe(true);
    expect(globMatches("*a*b", "xxaxxbxxc")).toBe(false);
    expect(globMatches("abc", "ab")).toBe(false);
    expect(globMatches("**", "")).toBe(true);
    const started = Date.now();
    expect(globMatches("*a*a*a*a*a*a*a*a*b", "a".repeat(VAULT_EXCLUSION_MAX_NAME))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("matching a connection's vault, then its objects", () => {
  test("a vault regex on the Key Vault NAME applies; the object side is glob/exact/regex, case-insensitive", () => {
    const compiled = compileVaultExclusions([
      rule({ vaultPattern: "^KV-PROD-", vaultPatternKind: "regex", objectPattern: "Prod-*", objectType: "secret" }),
      rule({
        vaultPattern: "kv-prod-app",
        vaultPatternKind: "exact",
        objectPattern: "EXACT",
        objectPatternKind: "exact",
        objectType: "key",
      }),
      rule({ objectPattern: "^cert-[0-9]+$", objectPatternKind: "regex", objectType: "certificate" }),
    ]);
    const matcher = compiled.forConnection(azure);
    expect(matcher.ruleCount).toBe(3);
    expect(matcher.excludes("secret", "prod-db")).toBe(true);
    expect(matcher.excludes("key", "prod-db")).toBe(false);
    expect(matcher.excludes("key", "exact")).toBe(true);
    expect(matcher.excludes("certificate", "CERT-12")).toBe(true);
    expect(matcher.excludes("certificate", "cert-x")).toBe(false);
  });

  test("a rule for another vault, another vault type, or a disabled rule does not apply", () => {
    const compiled = compileVaultExclusions([
      rule({ vaultPattern: "kv-dev-*" }),
      rule({ vaultType: "hashicorp-vault" }),
      rule({ enabled: false }),
    ]);
    expect(compiled.forConnection(azure)).toBe(NO_EXCLUSIONS);
    expect(NO_EXCLUSIONS.excludes("secret", "anything")).toBe(false);
    // Non-vault connections never match, whatever a rule says.
    expect(compileVaultExclusions([rule()]).forConnection({ ...base, type: "s3" } as ResourceConnection)).toBe(
      NO_EXCLUSIONS,
    );
    expect(compileVaultExclusions([rule({ vaultType: "azure-key-vault" })]).forConnection(azure).ruleCount).toBe(1);
  });

  test("regexes see only the bounded prefix; an invalid stored regex matches everything, unevaluated", () => {
    const tail = compileVaultExclusions([rule({ objectPattern: "z$", objectPatternKind: "regex" })]).forConnection(
      azure,
    );
    expect(tail.excludes("secret", `${"a".repeat(VAULT_EXCLUSION_MAX_REGEX_NAME)}z`)).toBe(false);
    const broken = compileVaultExclusions([
      rule({ vaultPattern: "(a+)+$", vaultPatternKind: "regex", objectPattern: "(a+)+$", objectPatternKind: "regex" }),
    ]).forConnection(azure);
    expect(broken.excludes("secret", "harmless")).toBe(true);
  });
});

describe("vault identities come from the connection the server runs", () => {
  test("Azure Key Vault: name, host and URL; the endpoint wins over vaultName, as the provider connects", () => {
    expect(vaultIdentities(azure)).toEqual([
      "kv-prod-app",
      "kv-prod-app.vault.azure.net",
      "https://kv-prod-app.vault.azure.net",
    ]);
    expect(vaultIdentities({ ...azure, vaultName: "decoy", endpoint: "HTTPS://Real-KV.vault.azure.net:443/" })).toEqual(
      ["real-kv", "real-kv.vault.azure.net", "https://real-kv.vault.azure.net"],
    );
    // Unparsable endpoints still yield their text.
    expect(vaultIdentities({ ...azure, endpoint: "not a url/" })).toEqual(["not a url"]);
  });

  test("HashiCorp Vault / OpenBao: host, URL, URL#namespace", () => {
    const hashicorp = { ...base, type: "hashicorp-vault", endpoint: "http://Vault.test:8200/" } as ResourceConnection;
    expect(vaultIdentities(hashicorp)).toEqual(["vault.test", "http://vault.test:8200"]);
    expect(vaultIdentities({ ...hashicorp, type: "openbao", namespace: " Team-A " })).toEqual([
      "vault.test",
      "http://vault.test:8200",
      "http://vault.test:8200#team-a",
    ]);
    expect(vaultIdentities({ ...hashicorp, endpoint: undefined })).toEqual([""]);
  });

  test("AWS: region, endpoint and region@endpoint", () => {
    const aws = { ...base, type: "aws-secrets-manager", region: "EU-West-1" } as ResourceConnection;
    expect(vaultIdentities(aws)).toEqual(["eu-west-1"]);
    expect(vaultIdentities({ ...aws, type: "aws-kms", endpoint: "http://localhost:4566" })).toEqual([
      "eu-west-1",
      "http://localhost:4566",
      "eu-west-1@http://localhost:4566",
    ]);
    expect(vaultIdentities({ ...aws, region: undefined })).toEqual([""]);
  });
});
