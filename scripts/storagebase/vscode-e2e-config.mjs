// The VS Code e2e configurations, adapted so they run from this fork's checkout (StorageBase fork, SEAMS.md S32).
//
// VS Code's main process listens on a Unix socket under its --user-data-dir, `<dir>/<version>-main.sock`, and macOS
// caps a socket path at 104 bytes. @vscode/test-electron defaults the directory to `<cwd>/.vscode-test/user-data`,
// and a hosted runner checks out to /Users/runner/work/<repo>/<repo>, so the four characters "storagebase-studio"
// has over "libredb-studio", twice, put the floor and stable builds' sockets over the cap: `listen EINVAL`, and no
// test runs. This module keeps upstream's configurations (vscode-extension/.vscode-test.mjs) and changes only where
// they resolve, since the config file now lives outside the extension: the file globs relative to the config's own
// directory (test-cli globs a relative pattern there and takes an absolute one literally), the extension and the
// workspace folder by absolute path; and on macOS a short --user-data-dir, unless the configuration already names one.
import { join, relative, resolve } from "node:path";

/** The vscode-extension directory, from this file's own directory. */
export const VSCODE_EXTENSION_DIR = resolve(import.meta.dirname, "../../vscode-extension");

/** `configs` resolved against `extensionDir` from `configDir`, with `userDataDir()` as their --user-data-dir on darwin. */
export function forkConfigurations(configs, { platform, configDir, extensionDir, userDataDir }) {
  return configs.map((config) => {
    const launchArgs = config.launchArgs ?? [];
    const named = launchArgs.some((arg) => /^--user-data-dir(=|$)/.test(arg));
    return {
      ...config,
      // A glob is forward-slashed on every platform, Windows included.
      files: relative(configDir, join(extensionDir, config.files)).replaceAll("\\", "/"),
      extensionDevelopmentPath: extensionDir,
      ...(config.workspaceFolder === undefined
        ? {}
        : { workspaceFolder: resolve(extensionDir, config.workspaceFolder) }),
      launchArgs: platform === "darwin" && !named ? [...launchArgs, `--user-data-dir=${userDataDir()}`] : launchArgs,
    };
  });
}
