import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { forkConfigurations, VSCODE_EXTENSION_DIR } from "../../../scripts/storagebase/vscode-e2e-config.mjs";

/**
 * The fork's `vscode-test --config` target for the VS Code smoke job (SEAMS.md S32): upstream's configurations,
 * resolved from scripts/storagebase/, with a short --user-data-dir on macOS so the main socket stays under the
 * 104-byte cap that the fork's longer checkout path broke.
 */

const ROOT = join(import.meta.dirname, "../../..");
const CONFIG_DIR = join(ROOT, "scripts/storagebase");
const EXTENSION_DIR = join(ROOT, "vscode-extension");

/**
 * The smoke subset's shape as vscode-extension/.vscode-test.mjs builds it, written out: importing that
 * module reaches @vscode/test-electron, which only the extension's own npm install provides, and the
 * root test job installs the root's dependencies alone.
 */
interface Configuration {
  label: string;
  version: string;
  files: string;
  workspaceFolder?: string;
  launchArgs?: string[];
}
const SMOKE: Configuration[] = [
  { label: "vscode-1.12", version: "1.12", files: "out/test/e2e/smoke/**/*.test.js" },
  { label: "vscode-1.14", version: "1.14", files: "out/test/e2e/smoke/**/*.test.js" },
];

function adapted(platform: string, configs: Configuration[] = SMOKE) {
  let made = 0;
  const result = forkConfigurations(configs, {
    platform,
    configDir: CONFIG_DIR,
    extensionDir: EXTENSION_DIR,
    userDataDir: () => {
      made += 1;
      return "/tmp/sbvsx-test";
    },
  });
  return { result, made };
}

describe("forkConfigurations", () => {
  test("the extension directory is the repository's vscode-extension", () => {
    expect(VSCODE_EXTENSION_DIR).toBe(EXTENSION_DIR);
  });

  test("keeps every upstream configuration, resolving the globs and the extension from the fork's config", () => {
    const { result } = adapted("linux");
    expect(result.map((config: Configuration) => config.label)).toEqual(["vscode-1.12", "vscode-1.14"]);
    for (const config of result) {
      expect(config.files).toBe("../../vscode-extension/out/test/e2e/smoke/**/*.test.js");
      expect(config.extensionDevelopmentPath).toBe(EXTENSION_DIR);
      expect(config.launchArgs).toEqual([]);
      expect(config.workspaceFolder).toBeUndefined();
    }
  });

  test("on macOS every configuration gets the short profile directory the factory hands out", () => {
    const { result, made } = adapted("darwin");
    for (const config of result) expect(config.launchArgs).toEqual(["--user-data-dir=/tmp/sbvsx-test"]);
    expect(made).toBe(result.length);
    // The longest socket VS Code names under it stays far under macOS's 104-byte cap.
    expect("/tmp/sbvsx-test/1.14-main.sock".length).toBeLessThan(104);
  });

  test("a configuration that names its own profile directory, or a workspace, keeps it", () => {
    const { result } = adapted("darwin", [
      {
        label: "x",
        version: "1",
        files: "out/a.test.js",
        workspaceFolder: "test/e2e-workspace/fixture",
        launchArgs: ["--user-data-dir=/elsewhere"],
      },
    ]);
    expect(result[0].launchArgs).toEqual(["--user-data-dir=/elsewhere"]);
    expect(result[0].workspaceFolder).toBe(join(EXTENSION_DIR, "test/e2e-workspace/fixture"));
    expect(result[0].files).toBe("../../vscode-extension/out/a.test.js");
  });
});
