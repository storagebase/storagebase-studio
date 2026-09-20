import { describe, test, expect } from "bun:test";
import { applyPairs, PAIRS, KEEP_TOKENS, SCOPE_DIRS, SCOPE_FILES } from "../../scripts/rename-fork.mjs";

/**
 * Drift guard for the fork rename (workstream M5). Upstream keeps adding
 * libredb identifiers; this pins the mapping contract so a new one either
 * renames correctly or fails loudly here instead of shipping.
 *
 * The guard tests the MAPPING, not the tree: `bun scripts/rename-fork.mjs
 * --check` (CI) asserts the tree already matches. Testing the tree here
 * would couple every release-surface edit to this file.
 */
describe("rename-fork mapping", () => {
  test("release identifiers rename across all case forms", () => {
    expect(applyPairs("name: libredb-studio")).toBe("name: storagebase-studio");
    expect(applyPairs("image: ghcr.io/libredb/libredb-studio:0.16.0")).toBe(
      "image: ghcr.io/storagebase/storagebase-studio:0.16.0",
    );
    expect(applyPairs("  name: libredbstudios.storagebase.org")).toBe(
      "  name: storagebasestudios.storagebase.org",
    );
    expect(applyPairs("kind: LibreDBStudio")).toBe("kind: StorageBaseStudio");
    expect(applyPairs("winget install LibreDB.Studio")).toBe("winget install StorageBase.Studio");
    expect(applyPairs("chart: helm-charts/libredb-studio")).toBe("chart: helm-charts/storagebase-studio");
    expect(applyPairs("deployment/libredb-libredb-studio")).toBe("deployment/storagebase-storagebase-studio");
  });

  test("kept tokens survive on lines that also rename", () => {
    // The engine dependency is not our identifier, even beside ones that are.
    expect(applyPairs('npm i @libredb/studio @libredb/libredb')).toBe('npm i @storagebase/studio @libredb/libredb');
    // Env names stay upstream-compatible per fork policy; URLs repoint.
    expect(applyPairs("Set LIBREDB_AGENT_ENABLED=false, see https://github.com/libredb/libredb-studio")).toBe(
      "Set LIBREDB_AGENT_ENABLED=false, see https://github.com/storagebase/storagebase-studio",
    );
    // A different product entirely, even mid-sentence with our package.
    expect(applyPairs("pure library for libredb-platform - server @libredb/studio")).toBe(
      "pure library for libredb-platform - server @storagebase/studio",
    );
  });

  test("longest-first ordering keeps compound names intact", () => {
    expect(applyPairs("libredb-studio-operator-controller-manager")).toBe(
      "storagebase-studio-operator-controller-manager",
    );
    expect(applyPairs("org.libredb.Studio")).toBe("org.storagebase.Studio");
    expect(applyPairs("studio.libredb.org_libredbstudios")).toBe("studio.storagebase.org_storagebasestudios");
  });

  test("applyPairs is idempotent — a renamed tree re-runs clean", () => {
    const once = applyPairs("image: ghcr.io/libredb/libredb-studio:latest");
    expect(applyPairs(once)).toBe(once);
    expect(once).toBe("image: ghcr.io/storagebase/storagebase-studio:latest");
  });

  test("every pair is reachable: no dead mapping, no shadowed general case", () => {
    // Each `from` must differ from its `to`, and no earlier pair may already
    // rewrite a later pair's `from` (which would make the later one dead).
    const seen = new Set<string>();
    for (const [from, to] of PAIRS) {
      expect(from).not.toBe(to);
      expect(seen.has(from), `duplicate mapping for ${from}`).toBe(false);
      seen.add(from);
    }
    for (let index = 0; index < PAIRS.length; index += 1) {
      const [from] = PAIRS[index];
      const rewritten = PAIRS.slice(0, index).reduce((text, [earlier]) => text.split(earlier).join(""), from);
      expect(rewritten).toBe(from);
    }
  });

  test("scope covers the release surface and nothing engine-owned", () => {
    for (const directory of ["bin", "charts", "operator", "packaging", "snap", "desktop", "distribution", "deploy", ".github", "scripts"]) {
      expect(SCOPE_DIRS).toContain(directory);
    }
    expect(SCOPE_FILES).toContain("package.json");
    // Engine runtime and fleet data stay out: renaming live volumes or the
    // engine type-id would orphan data and fork behavior for zero release value.
    expect(SCOPE_DIRS).not.toContain("docker");
    expect(SCOPE_DIRS).not.toContain("src");
    expect(SCOPE_DIRS).not.toContain("docs");
    expect(SCOPE_FILES).not.toContain("database-compose.yml");
  });

  test("keep tokens stay specific-first and anchored", () => {
    const sources = KEEP_TOKENS.map((pattern) => pattern.source);
    expect(sources.some((source) => source.includes("@libredb\\/libredb"))).toBe(true);
    expect(sources.some((source) => source.includes("LIBREDB_"))).toBe(true);
  });
});
