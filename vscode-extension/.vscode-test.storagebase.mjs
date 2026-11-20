// `vscode-test --config` target of the VS Code smoke job (StorageBase fork, SEAMS.md S32): upstream's configurations
// from .vscode-test.mjs, with a short macOS profile directory under /tmp. It sits here, not under scripts/storagebase,
// because test-cli resolves @vscode/test-electron from the config file's directory; the logic and its reasons live in
// ../scripts/storagebase/vscode-e2e-config.mjs.
import { mkdtempSync } from "node:fs";
import { forkConfigurations } from "../scripts/storagebase/vscode-e2e-config.mjs";
import { configurationsFor } from "./.vscode-test.mjs";

let userData;
export default forkConfigurations(configurationsFor(process.env), {
  platform: process.platform,
  configDir: import.meta.dirname,
  extensionDir: import.meta.dirname,
  userDataDir: () => (userData ??= mkdtempSync("/tmp/sbvsx-")),
});
