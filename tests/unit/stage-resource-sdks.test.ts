/**
 * Unit tests for the resource SDK staging step (scripts/stage-resource-sdks.mjs).
 *
 * `stageResourceSdks` runs against throwaway node_modules fixtures; the wiring
 * (next.config.ts externals, Dockerfile, standalone payload) is asserted as text
 * like the other packaging tests, because a real image build is out of reach
 * here. The runtime proof is a resource connection test against the image.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE_SDK_PACKAGES, stageResourceSdks } from "../../scripts/stage-resource-sdks.mjs";

const ROOT = join(import.meta.dir, "..", "..");
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
    writePackage(join(nm, "kafka-like"), { name: "kafka-like", dependencies: { shared: "1" } });
    writePackage(join(nm, "shared"), { name: "shared" });
    writePackage(join(nm, "helper"), { name: "helper" });
    writePackage(join(nm, "unrelated"), { name: "unrelated" });

    const { copied } = stageResourceSdks(root, out, ["@scope/sdk", "kafka-like"]);

    expect(copied).toEqual(["@scope/sdk", "helper", "kafka-like", "shared"]);
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

describe("resource SDK packaging wiring", () => {
  test("every staged SDK is a runtime dependency, so the builder's install has it", () => {
    const { dependencies } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    for (const sdk of RESOURCE_SDK_PACKAGES) {
      expect(dependencies).toHaveProperty([sdk]);
    }
  });

  test("the list matches the resource-family entries of serverExternalPackages", () => {
    const nextConfig = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    const externals = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(nextConfig)?.[1] ?? "";
    const resourceBlock = externals.slice(externals.indexOf("Resource families"));
    const listed = [...resourceBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    expect(listed).toEqual([...RESOURCE_SDK_PACKAGES]);
  });

  test("the Dockerfile stages the SDKs in the builder and lays them over the runner's node_modules", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("RUN node scripts/stage-resource-sdks.mjs /usr/src/app/.resource-sdks");
    expect(dockerfile).toContain("COPY --from=builder /usr/src/app/.resource-sdks/node_modules ./node_modules");
  });

  test("the standalone payload stages the same SDKs", () => {
    const script = readFileSync(join(ROOT, "scripts", "build-standalone-payload.sh"), "utf8");

    expect(script).toContain('node scripts/stage-resource-sdks.mjs "$PAYLOAD_DIR"');
  });
});
