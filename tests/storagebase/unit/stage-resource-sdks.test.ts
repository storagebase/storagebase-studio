/**
 * Unit tests for the fork SDK staging step (scripts/storagebase/stage-resource-sdks.mjs).
 *
 * `stageResourceSdks` runs against throwaway node_modules fixtures; the wiring (the S6 spread in
 * next.config.ts, the deps workspace, the Dockerfile.storagebase staging step) is asserted as text
 * like the other packaging tests, because a real image build is out of reach here. The runtime proof
 * is a resource connection test against the image.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE_SDK_PACKAGES, stageResourceSdks } from "../../../scripts/storagebase/stage-resource-sdks.mjs";

const ROOT = join(import.meta.dir, "..", "..", "..");
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.js"), `module.exports = ${JSON.stringify(manifest.name)};`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("stageResourceSdks", () => {
  test("copies the dependency closure, scoped and hoisted, and skips unrelated packages", () => {
    const root = tempDir("sdk-root-");
    const out = tempDir("sdk-out-");
    const nm = join(root, "node_modules");
    writePackage(join(nm, "@scope", "sdk"), { name: "@scope/sdk", dependencies: { shared: "1", helper: "1" } });
    writePackage(join(nm, "plain"), { name: "plain", dependencies: { shared: "1" } });
    writePackage(join(nm, "shared"), { name: "shared" });
    writePackage(join(nm, "helper"), { name: "helper" });
    writePackage(join(nm, "unrelated"), { name: "unrelated" });

    const { copied } = stageResourceSdks(root, out, ["@scope/sdk", "plain"]);

    expect(copied).toEqual(["@scope/sdk", "helper", "plain", "shared"]);
    expect(existsSync(join(out, "node_modules", "@scope", "sdk", "index.js"))).toBe(true);
    expect(existsSync(join(out, "node_modules", "unrelated"))).toBe(false);
  });

  test("a nested package travels with its parent while its own dependencies are still walked", () => {
    const root = tempDir("sdk-root-");
    const out = tempDir("sdk-out-");
    const nm = join(root, "node_modules");
    writePackage(join(nm, "sdk"), { name: "sdk", dependencies: { pinned: "2" } });
    // A version conflict leaves `pinned@2` nested under sdk; its dependency is hoisted.
    writePackage(join(nm, "sdk", "node_modules", "pinned"), { name: "pinned", dependencies: { hoisted: "1" } });
    writePackage(join(nm, "pinned"), { name: "pinned" });
    writePackage(join(nm, "hoisted"), { name: "hoisted" });

    const { copied } = stageResourceSdks(root, out, ["sdk"]);

    expect(copied).toEqual(["hoisted", "sdk"]);
    expect(existsSync(join(out, "node_modules", "sdk", "node_modules", "pinned", "package.json"))).toBe(true);
    // The top-level pinned@1 is not in the closure.
    expect(existsSync(join(out, "node_modules", "pinned"))).toBe(false);
  });

  test("optional and peer dependencies are copied when installed and skipped when not", () => {
    const root = tempDir("sdk-root-");
    const out = tempDir("sdk-out-");
    const nm = join(root, "node_modules");
    writePackage(join(nm, "sdk"), {
      name: "sdk",
      optionalDependencies: { "present-optional": "1", "absent-optional": "1" },
      peerDependencies: { "absent-peer": "1" },
    });
    writePackage(join(nm, "present-optional"), { name: "present-optional" });

    expect(stageResourceSdks(root, out, ["sdk"]).copied).toEqual(["present-optional", "sdk"]);
  });

  test("a missing required dependency fails with the package that needs it", () => {
    const root = tempDir("sdk-root-");
    const out = tempDir("sdk-out-");
    writePackage(join(root, "node_modules", "sdk"), { name: "sdk", dependencies: { gone: "1" } });

    expect(() => stageResourceSdks(root, out, ["sdk"])).toThrow(
      "gone (required by sdk) is not installed - run 'bun install --frozen-lockfile'",
    );
  });

  test("restaging replaces a previous copy instead of merging into it", () => {
    const root = tempDir("sdk-root-");
    const out = tempDir("sdk-out-");
    writePackage(join(root, "node_modules", "sdk"), { name: "sdk" });
    mkdirSync(join(out, "node_modules", "sdk"), { recursive: true });
    writeFileSync(join(out, "node_modules", "sdk", "stale.js"), "");

    stageResourceSdks(root, out, ["sdk"]);

    expect(existsSync(join(out, "node_modules", "sdk", "stale.js"))).toBe(false);
  });
});

describe("fork SDK packaging wiring", () => {
  test("every staged SDK is a dependency of the fork's deps workspace", () => {
    const { dependencies } = JSON.parse(
      readFileSync(join(ROOT, "packages", "storagebase-deps", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    for (const sdk of RESOURCE_SDK_PACKAGES) {
      expect(dependencies).toHaveProperty([sdk]);
    }
  });

  test("next.config.ts reaches the list through the S6 spread, never a literal", () => {
    const nextConfig = readFileSync(join(ROOT, "next.config.ts"), "utf8");

    expect(nextConfig).toContain("...STORAGEBASE_SERVER_EXTERNALS,");
    expect(nextConfig).toContain('import { STORAGEBASE_SERVER_EXTERNALS } from "./src/storagebase/core/externals";');
  });

  test("Dockerfile.storagebase installs the workspace and stages the SDKs into the payload", () => {
    const dockerfile = readFileSync(join(ROOT, "deploy", "storagebase", "Dockerfile.storagebase"), "utf8");

    expect(dockerfile).toContain("COPY packages/storagebase-deps/package.json ./packages/storagebase-deps/package.json");
    expect(dockerfile).toContain("node scripts/storagebase/stage-resource-sdks.mjs .next/standalone");
  });

  test("upstream's Dockerfile stays untouched: no fork staging in it", () => {
    const upstream = readFileSync(join(ROOT, "Dockerfile"), "utf8");

    expect(upstream).not.toContain("storagebase");
  });
});
