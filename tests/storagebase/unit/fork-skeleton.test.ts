/**
 * Phase-0 skeleton invariants: the three copies of the fork SDK list cannot drift, because they are
 * written in three formats that no compiler connects — a TypeScript const (next.config's S6 spread,
 * src/storagebase/core/externals.ts), a plain-node literal (the Docker staging script, which cannot
 * import TypeScript), and knip's ignoreDependencies (the deps workspace's own consumer lives in the
 * root workspace, so knip cannot see the usage). A test holding them equal is the only connection.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORAGEBASE_SERVER_EXTERNALS } from "../../../src/storagebase/core/externals";
import { RESOURCE_SDK_PACKAGES } from "../../../scripts/storagebase/stage-resource-sdks.mjs";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("the fork SDK list, held equal in every copy", () => {
  test("the TypeScript const and the staging script literal are the same set", () => {
    expect(RESOURCE_SDK_PACKAGES).toEqual(STORAGEBASE_SERVER_EXTERNALS);
  });

  test("knip's storagebase-deps ignoreDependencies matches the externals list", () => {
    const knip = JSON.parse(readFileSync(join(ROOT, "knip.json"), "utf8")) as {
      workspaces: Record<string, { ignoreDependencies?: string[] }>;
    };
    const ignored = knip.workspaces["packages/storagebase-deps"].ignoreDependencies ?? [];

    expect(ignored).toEqual(STORAGEBASE_SERVER_EXTERNALS);
  });

  test("the deps workspace declares exactly the externals list", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages", "storagebase-deps", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies).sort()).toEqual([...STORAGEBASE_SERVER_EXTERNALS].sort());
  });
});

describe("the one-time workspace seams", () => {
  test("root package.json carries the workspaces field and nothing else fork-shaped", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      workspaces?: string[];
      dependencies: Record<string, string>;
    };

    expect(manifest.workspaces).toEqual(["packages/*"]);
    for (const forkSdk of STORAGEBASE_SERVER_EXTERNALS) {
      expect(manifest.dependencies).not.toHaveProperty([forkSdk]);
    }
  });

  test("the sync workflow regenerates the lockfile the documented way", () => {
    const workflow = readFileSync(
      join(ROOT, ".github", "workflows", "storagebase-upstream-sync.yml"),
      "utf8",
    );

    expect(workflow).toContain("git checkout \"$TAG\" -- bun.lock");
    expect(workflow).toContain("bun install");
    expect(workflow).toContain("node scripts/storagebase/seam-check.mjs");
  });
});
