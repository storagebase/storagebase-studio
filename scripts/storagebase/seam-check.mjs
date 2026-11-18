#!/usr/bin/env node
/**
 * Seam ledger enforcement (StorageBase fork).
 *
 * The fork's design goal is a mechanical weekly upstream merge: every fork change lives under a path
 * upstream does not have, and the ONLY upstream files the fork edits are the seams in SEAMS.md. Nothing
 * else enforces that discipline — a hot upstream file quietly edited today is a multi-hour merge
 * conflict next Tuesday — so this script is the enforcement, in CI and before every push:
 *
 *   1. Diff HEAD against the merge-base with the tracked upstream ref, keeping only paths that exist
 *      upstream (a fork-added file cannot conflict, so it is not the ledger's business).
 *   2. Every kept path must appear in SEAMS.md, otherwise the edit is forbidden.
 *      A DELETED upstream path counts: the old fork deleted leaf modules and paid for it on every sync.
 *   3. Per ledger file, the diff must stay within the row's budget (`+N/−M` added/removed lines vs the
 *      merge-base). `regenerated` rows (bun.lock) are exempt from the budget, never from the listing.
 *   4. Print the ledger with each file's upstream churn (commits in the last 60 days), because a seam
 *      in a hot file is a standing cost the ledger's "why" column has to keep justifying.
 *
 * The upstream ref is `libredb/main` by default; override with --ref or STORAGEBASE_UPSTREAM_REF. When
 * the ref is missing locally the script fails with fetch instructions rather than passing vacuously.
 *
 * The pure parts (parseArgs, parseLedger) are exported for tests/storagebase/unit/seam-check.test.ts;
 * the CLI arm runs only when executed directly, so importing this module in a test is inert.
 *
 * Usage: node scripts/storagebase/seam-check.mjs [--ref <upstream-ref>] [--base <commit-ish>]
 *   --ref   upstream remote ref to merge-base against (default: libredb/main)
 *   --base  explicit base commit; skips the merge-base computation (local debugging)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

/** One ledger row: the seam id, its file, and its spend budget (or a `regenerated` exemption). */

/** Runs one git command in the repo root and returns its stdout, failing loudly. */
function git(args) {
  // stderr piped, never inherited: probe calls like `cat-file -e` are EXPECTED to fail on fork-owned
  // paths, and their "fatal: path exists on disk, but not in …" noise belongs nowhere, least of all
  // in a CI log someone has to read.
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * @param {string[]} argv
 * @returns {{ ref: string, base: string | null }}
 */
export function parseArgs(argv) {
  const options = { ref: process.env.STORAGEBASE_UPSTREAM_REF ?? "libredb/main", base: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ref") {
      options.ref = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--base") {
      options.base = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return options;
}

/**
 * Parses SEAMS.md into ledger rows. The table is the machine-checked part of the doc: one row per file
 * (two-file seams get S8a/S8b ids), cells `| id | \`path\` | budget | … |`. A budget is `+N/−M` or the
 * literal `regenerated`. The unicode minus is normalised because budgets are prose-adjacent.
 *
 * Takes the text rather than reading the file so the unit test can drive fixtures.
 *
 * @param {string} text
 * @returns {Map<string, { id: string, added: number, removed: number, regenerated: boolean }>}
 */
export function parseLedger(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^\|\s*(S\d+[a-z]?)\s*\|\s*`([^`]+)`\s*\|\s*(\+\d+\s*\/\s*[−-]\d+|regenerated)\s*\|/);
    if (match === null) continue;
    const [, id, file, rawBudget] = match;
    if (rawBudget === "regenerated") {
      rows.set(file, { id, added: Number.POSITIVE_INFINITY, removed: Number.POSITIVE_INFINITY, regenerated: true });
    } else {
      // The budget's `−M` is a prose allowance (M lines may be removed), not a negative number:
      // parse the magnitude, or `removed > row.removed` would pass on any spend at all.
      const [addedRaw, removedRaw] = rawBudget.replace("−", "-").split("/");
      const added = Number.parseInt(addedRaw, 10) || 0;
      const removed = Math.abs(Number.parseInt(removedRaw, 10)) || 0;
      rows.set(file, { id, added, removed, regenerated: false });
    }
  }
  if (rows.size === 0) throw new Error("SEAMS.md parsed to zero rows: the ledger table format is broken.");
  return rows;
}

/** Resolves the upstream base: the explicit --base, else the merge-base with the upstream ref. */
function resolveBase(options) {
  if (options.base !== null) return options.base;
  try {
    git(["rev-parse", "--verify", `${options.ref}^{commit}`]);
  } catch {
    console.error(`The upstream ref ${options.ref} is not present locally. Fetch it first:`);
    console.error("  git remote add libredb https://github.com/libredb/libredb-studio.git  # once");
    console.error("  git fetch libredb main --tags");
    console.error("or pass --base <commit-ish> to check against an explicit base.");
    process.exit(1);
  }
  return git(["merge-base", "HEAD", options.ref]).trim();
}

/**
 * Checks one fork-vs-upstream diff against the ledger: the changed upstream files, and the violations
 * (unlisted paths, over-budget seams, ledger rows whose target upstream no longer carries).
 *
 * @param {ReturnType<typeof parseLedger>} ledger
 * @param {Map<string, string>} changes upstream path -> diff status letter (M/D/T/…)
 * @param {(file: string) => { added: number, removed: number }} numstat
 * @param {(file: string) => boolean} existsAtBase
 * @returns {string[]}
 */
export function checkAgainstLedger(ledger, changes, numstat, existsAtBase) {
  const violations = [];
  for (const [file, row] of ledger) {
    if (!existsAtBase(file)) {
      violations.push(`${row.id}: ${file} does not exist at the upstream base — the seam target moved; update SEAMS.md.`);
    }
  }
  const unlisted = [];
  for (const [file, status] of changes) {
    if (!existsAtBase(file)) continue; // fork-owned path: cannot conflict, not the ledger's business.
    const row = ledger.get(file);
    if (row === undefined) {
      unlisted.push(`${status === "D" ? "deleted" : "edited"} ${file}`);
      continue;
    }
    if (row.regenerated) continue; // bun.lock policy: regenerated, never hand-resolved.
    const { added, removed } = numstat(file);
    if (added > row.added || removed > row.removed) {
      violations.push(`${row.id}: ${file} spent +${added}/−${removed}, over its +${row.added}/−${row.removed} budget.`);
    }
  }
  if (unlisted.length > 0) {
    violations.push(...unlisted.map((entry) => `upstream file changed but not in SEAMS.md: ${entry}`));
  }
  return violations;
}

/** The upstream paths this fork has touched: status + numstat, renames split into their two halves. */
function forkChangesAgainst(base) {
  const changes = new Map();
  const status = git(["diff", "--name-status", "--no-renames", base, "HEAD"]);
  for (const line of status.split("\n")) {
    if (line === "") continue;
    const [rawStatus, ...rest] = line.split("\t");
    changes.set(rest[rest.length - 1], rawStatus[0]);
  }
  return changes;
}

/** Upstream churn per ledger file: commits touching it on the upstream ref in the last 60 days. */
function upstreamChurn(ref, file) {
  try {
    const out = git(["log", "--oneline", "--since=60 days ago", ref, "--", file]);
    return out.split("\n").filter((line) => line !== "").length;
  } catch {
    return -1;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const ledger = parseLedger(readFileSync(path.join(root, "SEAMS.md"), "utf8"));
  const base = resolveBase(options);
  const changes = forkChangesAgainst(base);
  const numstat = (file) => {
    const out = git(["diff", "--numstat", "--no-renames", base, "HEAD", "--", file]);
    let added = 0;
    let removed = 0;
    for (const line of out.split("\n")) {
      if (line === "") continue;
      const [add, del] = line.split("\t");
      added += Number.parseInt(add, 10) || 0;
      removed += Number.parseInt(del, 10) || 0;
    }
    return { added, removed };
  };
  const existsAtBase = (file) => {
    try {
      git(["cat-file", "-e", `${base}:${file}`]);
      return true;
    } catch {
      return false;
    }
  };
  const violations = checkAgainstLedger(ledger, changes, numstat, existsAtBase);

  // The report, green or red: churn is the standing cost each row has to keep justifying.
  console.log(`Seam check against ${options.ref} (base ${base.slice(0, 8)}) — ${ledger.size} ledger rows, ${changes.size} changed paths.\n`);
  const idWidth = Math.max(...[...ledger.values()].map((row) => row.id.length), 3);
  for (const [file, row] of ledger) {
    const churn = upstreamChurn(options.ref, file);
    const churnNote = churn < 0 ? "n/a" : `${churn} commits / 60 days`;
    const spent = changes.has(file)
      ? (() => {
          const { added, removed } = numstat(file);
          return `spent +${added}/−${removed} (status ${changes.get(file)})`;
        })()
      : "untouched by the fork";
    const budget = row.regenerated ? "regenerated  " : `budget +${row.added}/−${row.removed}`;
    console.log(`  ${row.id.padEnd(idWidth)}  ${file.padEnd(48)} ${budget}  ${spent}  upstream: ${churnNote}`);
  }
  console.log("");

  if (violations.length > 0) {
    for (const violation of violations) console.error(`seam-check: ${violation}`);
    console.error("\nFix the fork side: move the change under src/storagebase/** (or another fork-owned path),");
    console.error("or get the owner's approval for a new SEAMS.md ledger row before spending its budget.");
    process.exit(1);
  }
  console.log("seam-check: green — every upstream edit is a ledgered seam within budget.");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
