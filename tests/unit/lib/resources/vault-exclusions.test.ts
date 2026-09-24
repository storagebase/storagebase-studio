import { describe, test, expect } from "bun:test";
import { ResourceInvalidRequestError } from "@/lib/resources/errors";
import {
  compileExclusions,
  exclusionKey,
  globMatches,
  NO_EXCLUSIONS,
  normalizedVaultAddress,
  unsafeRegexReason,
  validateExclusionRules,
  vaultIdentity,
  VAULT_EXCLUSION_MAX_NAME,
  VAULT_EXCLUSION_MAX_REGEX_NAME,
  VAULT_EXCLUSION_MAX_RULES,
  type VaultExclusionRule,
} from "@/lib/resources/vault-exclusions";
import type { ResourceConnection } from "@/lib/resources/types";

const base = { id: "r", name: "n", createdAt: "2026-01-01T00:00:00.000Z" };

function rule(pattern: string, kind: VaultExclusionRule["kind"], objectType: VaultExclusionRule["objectType"] = "any") {
  return { pattern, kind, objectType, note: "" };
}

describe("vault exclusion rules", () => {
  test("validation accepts the three kinds and defaults the note", () => {
    expect(
      validateExclusionRules([
        { pattern: "db-*", kind: "glob", objectType: "secret" },
        { pattern: "exact-name", kind: "exact", objectType: "any", note: "why" },
        { pattern: "^prod-[a-z]+$", kind: "regex", objectType: "key" },
      ]),
    ).toEqual([
      rule("db-*", "glob", "secret"),
      { ...rule("exact-name", "exact"), note: "why" },
      rule("^prod-[a-z]+$", "regex", "key"),
    ]);
  });

  test("validation refuses every malformed field with the rule's number", () => {
    const cases: Array<[unknown, string]> = [
      ["nope", '"rules" must be an array'],
      [Array.from({ length: VAULT_EXCLUSION_MAX_RULES + 1 }, () => rule("a", "exact")), "At most"],
      [[null], 'Rule 1: "pattern"'],
      [[{ ...rule(" ", "exact") }], 'Rule 1: "pattern"'],
      [[rule("x".repeat(201), "exact")], "at most 200"],
      [[{ ...rule("a", "exact"), kind: "fuzzy" }], '"kind"'],
      [[{ ...rule("a", "exact"), objectType: "blob" }], '"objectType"'],
      [[{ ...rule("a", "exact"), note: 5 }], '"note"'],
      [[rule("(a+)+", "regex")], "repeated group"],
    ];
    for (const [input, sentence] of cases) {
      const error = (() => {
        try {
          validateExclusionRules(input);
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(ResourceInvalidRequestError);
      expect((error as Error).message).toContain(sentence);
    }
  });

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
    // Harmless groups, escapes, classes and bounded repeats pass.
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
    // Linear on a hostile input: many stars against a long near-miss.
    const started = Date.now();
    expect(globMatches("*a*a*a*a*a*a*a*a*b", "a".repeat(VAULT_EXCLUSION_MAX_NAME))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("matching is case-insensitive, per object type, and bounded", () => {
    const matcher = compileExclusions([
      rule("Prod-*", "glob", "secret"),
      rule("EXACT", "exact", "key"),
      rule("^cert-[0-9]+$", "regex", "certificate"),
      rule("everything-*", "glob", "any"),
    ]);
    expect(matcher.excludes("secret", "prod-db")).toBe(true);
    expect(matcher.excludes("key", "prod-db")).toBe(false);
    expect(matcher.excludes("key", "exact")).toBe(true);
    expect(matcher.excludes("certificate", "CERT-12")).toBe(true);
    expect(matcher.excludes("certificate", "cert-x")).toBe(false);
    expect(matcher.excludes("key", "everything-x")).toBe(true);
    // Regexes see only the bounded prefix of a name.
    const tail = compileExclusions([rule("z$", "regex", "any")]);
    expect(tail.excludes("secret", `${"a".repeat(VAULT_EXCLUSION_MAX_REGEX_NAME)}z`)).toBe(false);
    expect(NO_EXCLUSIONS.excludes("secret", "anything")).toBe(false);
  });

  test("a stored regex that no longer passes the grammar hides everything of its type, unevaluated", () => {
    const matcher = compileExclusions([rule("(a+)+$", "regex", "secret")]);
    expect(matcher.excludes("secret", "harmless")).toBe(true);
    expect(matcher.excludes("key", "harmless")).toBe(false);
  });

  test("the vault identity normalizes each family's address", () => {
    const azure = { ...base, type: "azure-key-vault" } as ResourceConnection;
    expect(normalizedVaultAddress({ ...azure, endpoint: "HTTPS://Example.vault.azure.net:443/" })).toBe(
      "https://example.vault.azure.net",
    );
    expect(normalizedVaultAddress({ ...azure, vaultName: "example" })).toBe("https://example.vault.azure.net");
    expect(normalizedVaultAddress(azure)).toBe("https://.vault.azure.net");
    const hashicorp = { ...base, type: "hashicorp-vault", endpoint: "http://vault.test:8200/" } as ResourceConnection;
    expect(normalizedVaultAddress(hashicorp)).toBe("http://vault.test:8200");
    expect(normalizedVaultAddress({ ...hashicorp, type: "openbao", namespace: " Team-A " })).toBe(
      "http://vault.test:8200#team-a",
    );
    expect(normalizedVaultAddress({ ...hashicorp, endpoint: undefined })).toBe("");
    const aws = { ...base, type: "aws-secrets-manager", region: "EU-West-1" } as ResourceConnection;
    expect(normalizedVaultAddress(aws)).toBe("eu-west-1");
    expect(normalizedVaultAddress({ ...aws, region: undefined, endpoint: "http://localhost:4566" })).toBe(
      "default@http://localhost:4566",
    );
    expect(vaultIdentity(aws)).toBe("vault-exclusions:aws-secrets-manager:eu-west-1");
    expect(exclusionKey("aws-kms", " EU ")).toBe("vault-exclusions:aws-kms:eu");
  });
});
