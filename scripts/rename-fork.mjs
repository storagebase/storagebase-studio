#!/usr/bin/env bun
/**
 * Fork identifier rename (StorageBase workstream M5).
 *
 * Rewrites release/packaging identifiers from libredb-* to storagebase-*
 * across the release surface, and ONLY there. Run explicitly; CI runs it
 * with --check (see tests/unit/packaging-fork-rename.test.ts), and it is
 * re-applied after every upstream merge (docs/UPSTREAM_SYNC.md) because
 * upstream keeps adding libredb identifiers that must not ship.
 *
 * WHAT RENAMES: npm scope/name/bin, image registries, chart + operator
 * (incl. CRD group/kind/plurals), launcher URLs/cache, snap/flatpak/
 * homebrew/winget/nfpm/desktop metadata, workflows, distribution channels.
 *
 * WHAT NEVER RENAMES (exclusions below, each with its reason):
 * - `@libredb/libredb` — the engine dependency from npm, not our identifier.
 * - `libredb-platform` — a different product that embeds this package.
 * - `LIBREDB_*` env names — kept upstream-compatible by fork policy
 *   (STORAGEBASE.md); only values/URLs pointing at our infra repoint.
 * - The `libredb` database engine type-id and its seed/fleet names
 *   (docker/*, database-compose.yml): runtime data paths, not release
 *   identifiers — renaming orphans live volumes for zero product value.
 * - `github.com/libredb/*` is NOT blanket-excluded: our release URLs repoint
 *   to storagebase, while upstream-remote notices keep pointing upstream.
 *   Ambiguous lines are reviewed in the diff, not guessed by the script —
 *   see the UPSTREAM_URLS_REVIEW list the script prints in --check output.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";

/** Applied top-down per line, longest first. */
/** @type {Array<[string, string]>} */
export const PAIRS = [
  ["libredb-libredb-studio", "storagebase-storagebase-studio"],
  ["libredb-studio-operator", "storagebase-studio-operator"],
  ["libredb-studio-desktop", "storagebase-studio-desktop"],
  ["libredb-studio-standalone-", "storagebase-studio-standalone-"],
  ["libredb-studio-node", "storagebase-studio-node"],
  ["libredb-studio-wrapper", "storagebase-studio-wrapper"],
  ["libredb-studio-", "storagebase-studio-"],
  ["libredb-studio", "storagebase-studio"],
  ["libredbDesktopHandoff", "storagebaseDesktopHandoff"],
  ["libredbDesktopFailure", "storagebaseDesktopFailure"],
  ["libredbstudios", "storagebasestudios"],
  ["libredbstudio", "storagebasestudio"],
  ["LibreDBStudio", "StorageBaseStudio"],
  ["LibreDB-Studio", "StorageBase-Studio"],
  ["LibreDB_Studio", "StorageBase_Studio"],
  ["LibreDB", "StorageBase"],
  ["libredb", "storagebase"],
];

/**
 * Tokens rewritten back after the pairs run (placeholder round-trip), so a
 * line carrying both a kept token and a renamed one still renames correctly.
 * Order matters: specific before general (`@libredb/libredb` before the env
 * pattern cannot collide, but keep the list specific-first by convention).
 */
/** @type {RegExp[]} */
export const KEEP_TOKENS = [
  /@libredb\/libredb/g,
  /libredb-platform/g,
  /LIBREDB_[A-Z_]+/g,
  // The `libredb` database engine type-id as a bare quoted literal. Release
  // identifiers never spell exactly this (they all carry a suffix), so the
  // quotes make the engine the only match — measured: marketplace-copy's
  // `type !== "libredb"` filter corrupted to `"storagebase"` without it.
  /(["'])libredb\1/g,
];

/** Directories (repo-relative) the rename walks. Engine runtime and docs prose stay out. */
/** @type {string[]} */
export const SCOPE_DIRS = [
  "bin",
  "charts",
  "operator",
  "packaging",
  "snap",
  "desktop",
  "distribution",
  "deploy",
  ".github",
  // Release tooling references release paths (chart dirs, template names,
  // image repos) and must track them. rename-fork.mjs itself is excluded
  // below: its mapping table is the transformation, not its target.
  "scripts",
];

/** Repo-root files in scope. */
/** @type {string[]} */
export const SCOPE_FILES = [
  "package.json",
  "Dockerfile",
  "fly.toml",
  "render.yaml",
  "docker-compose.yml",
  "docker-compose.example.yml",
];

/** Filenames that never rewrite, however tempting. */
/** @type {RegExp[]} */
export const EXCLUDE_FILES = [
  /bun\.lock$/,
  /\.snap$/,
  /\.sum$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /rename-fork\.mjs$/,
];

/** @param {number} index */
const PLACEHOLDER = (index) => `__STORAGEBASE_KEEP_${index}__`;

/** @param {string} line */
export function applyPairs(line) {
  const kept = [];
  const shielded = line.replace(
    new RegExp(KEEP_TOKENS.map((pattern) => `(?:${pattern.source})`).join("|"), "g"),
    (match) => {
      kept.push(match);
      return PLACEHOLDER(kept.length - 1);
    },
  );
  const renamed = PAIRS.reduce((text, [from, to]) => text.split(from).join(to), shielded);
  return renamed.replace(/__STORAGEBASE_KEEP_(\d+)__/g, (_, index) => kept[Number(index)]);
}

/** @param {string} root */
function listFiles(root) {
  const out = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const relativePath = relative(root, full);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        walk(full);
      } else if (!EXCLUDE_FILES.some((pattern) => pattern.test(relativePath))) {
        out.push(full);
      }
    }
  };
  for (const directory of SCOPE_DIRS) {
    const full = join(root, directory);
    if (existsSync(full)) walk(full);
  }
  for (const file of SCOPE_FILES) {
    const full = join(root, file);
    if (existsSync(full) && !EXCLUDE_FILES.some((pattern) => pattern.test(file))) out.push(full);
  }
  return out.sort();
}

/** @param {string} root @param {boolean} check */
function renamePaths(root, check) {
  // Path renames mirror the content pairs so directory/file names track their
  // contents (charts/libredb-studio, CRD bases, winget/flatpak metadata).
  // node_modules is untracked and never walked; bun.lock is excluded above.
  const moved = [];
  for (const file of listFiles(root)) {
    const relativePath = relative(root, file);
    const renamed = PAIRS.reduce((text, [from, to]) => text.split(from).join(to), relativePath);
    if (renamed !== relativePath) {
      moved.push(`${relativePath} -> ${renamed}`);
      if (!check) {
        mkdirSync(dirname(join(root, renamed)), { recursive: true });
        renameSync(file, join(root, renamed));
      }
    }
  }
  return moved;
}

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const check = process.argv.includes("--check");

// Side-effect free on import: the unit tests import the pure pieces
// (PAIRS, KEEP_TOKENS, applyPairs) without renaming the checkout.
if (import.meta.main) {
  run(root, check);
}

function run(root, check) {
  let changed = 0;
  const upstreamReview = [];

  for (const file of listFiles(root)) {
    const before = readFileSync(file, "utf8");
    const after = before
      .split("\n")
      .map((line) => applyPairs(line))
      .join("\n");
    if (after !== before) {
      changed += 1;
      if (!check) writeFileSync(file, after);
    }
    if (/github\.com\/libredb\//.test(after)) {
      upstreamReview.push(relative(root, file));
    }
  }

  const moved = renamePaths(root, check);

  if (check) {
    if (changed > 0 || moved.length > 0) {
      console.error(`rename-fork: ${changed} files and ${moved.length} paths would change; run without --check`);
      process.exit(1);
    }
    console.log("rename-fork: clean");
  } else {
    console.log(`rename-fork: rewrote ${changed} files, moved ${moved.length} paths`);
  }
  if (upstreamReview.length > 0) {
    console.log("UPSTREAM_URLS_REVIEW (github.com/libredb survivors — confirm each means upstream):");
    for (const file of [...new Set(upstreamReview)].sort()) console.log(`  ${file}`);
  }
}
