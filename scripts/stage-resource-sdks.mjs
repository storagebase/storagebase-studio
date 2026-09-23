#!/usr/bin/env node
/**
 * Resource SDK staging (StorageBase fork).
 *
 * The resource providers load their SDKs through `loadResourceSdk`, whose
 * import specifier is computed and carries bundler-ignore comments (so node-only
 * SDKs never enter a browser bundle). That also hides them from Next's output
 * file tracing: the standalone server gets none of them, and every resource
 * connection in the Docker image failed with "... is not available in this
 * environment". It is the @duckdb / @libredb/libredb blind spot again, with a
 * different shape - these SDKs have deep dependency trees (@aws-sdk/* alone
 * pulls dozens of @smithy/* packages), so a COPY per package is not enough.
 *
 * This walks each SDK's runtime dependency closure through the installed
 * node_modules - so versions are exactly what the lockfile installed - and
 * copies it to `<outDir>/node_modules`, which the Dockerfile runner stage and
 * scripts/build-standalone-payload.sh lay over the traced standalone tree.
 * Unit tested in tests/unit/stage-resource-sdks.test.ts (the CLI arm is proven by the image build).
 *
 * Usage: node scripts/stage-resource-sdks.mjs <outDir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The resource-family entries of `serverExternalPackages` in next.config.ts -
 * the test holds the two lists equal.
 */
export const RESOURCE_SDK_PACKAGES = [
  "@aws-sdk/client-s3",
  "@aws-sdk/client-sqs",
  "@aws-sdk/client-kms",
  "@aws-sdk/client-secrets-manager",
  "@azure/storage-blob",
  "@azure/keyvault-secrets",
  "@azure/identity",
  "kafkajs",
  "amqplib",
];

/**
 * Node's lookup: `<dir>/node_modules/<name>`, walking up from `fromDir` to `root`.
 *
 * @param {string} name
 * @param {string} fromDir
 * @param {string} root
 * @returns {string | null}
 */
function resolvePackageDir(name, fromDir, root) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Copies every package in the runtime closure of `packages` from
 * `<root>/node_modules` into `<outDir>/node_modules`. A package nested inside
 * another package's node_modules travels with its parent; its own
 * dependencies are still walked.
 *
 * @param {string} root Directory holding the installed node_modules.
 * @param {string} outDir Where the staged node_modules is written.
 * @param {readonly string[]} [packages]
 * @returns {{ copied: string[] }} Top-level package names copied, sorted.
 */
export function stageResourceSdks(root, outDir, packages = RESOURCE_SDK_PACKAGES) {
  const topLevel = path.join(root, "node_modules");
  const seen = new Set();
  const copied = [];
  /** @type {Array<{ name: string, fromDir: string, optional: boolean, requiredBy: string }>} */
  const queue = packages.map((name) => ({ name, fromDir: root, optional: false, requiredBy: "(root)" }));

  while (queue.length > 0) {
    const { name, fromDir, optional, requiredBy } = /** @type {NonNullable<ReturnType<typeof queue.shift>>} */ (
      queue.shift()
    );
    const dir = resolvePackageDir(name, fromDir, root);
    if (dir === null) {
      if (optional) continue;
      throw new Error(`${name} (required by ${requiredBy}) is not installed - run 'bun install --frozen-lockfile'`);
    }
    if (seen.has(dir)) continue;
    seen.add(dir);

    if (path.dirname(dir) === topLevel || path.dirname(path.dirname(dir)) === topLevel) {
      const target = path.join(outDir, "node_modules", name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(dir, target, { recursive: true, dereference: true });
      copied.push(name);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dep, fromDir: dir, optional: false, requiredBy: name });
    }
    for (const dep of [
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      queue.push({ name: dep, fromDir: dir, optional: true, requiredBy: name });
    }
  }

  return { copied: copied.sort() };
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/stage-resource-sdks.mjs <outDir>");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { copied } = stageResourceSdks(root, path.resolve(outDir));
    console.log(`Staged ${copied.length} packages for ${RESOURCE_SDK_PACKAGES.length} resource SDKs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
