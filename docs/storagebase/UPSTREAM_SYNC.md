# Upstream sync runbook (StorageBase fork)

The fork tracks `libredb/libredb-studio`. This is the repeatable procedure for pulling their work in;
`.github/workflows/storagebase-upstream-sync.yml` runs it weekly on schedule and can be started from
the Actions tab at any time. The acceptance bar for the porting work was simple: **merging the next
upstream tag produces zero conflicts outside the SEAMS.md ledger.**

## Remotes

- `origin` → the fork (`storagebase/storagebase-studio`); `main` was reset to upstream tag `1.3.0`
  at the re-fork; the old fork lives on `legacy/0.16-main`.
- `libredb` → `https://github.com/libredb/libredb-studio.git`

## Procedure (what the workflow does, by hand)

1. `git fetch libredb main --tags` and pick the newest **bare-semver** tag
   (`git tag --list --sort=-v:refname --merged libredb/main | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1`).
   Skip if `git merge-base --is-ancestor <tag> main` says it is already merged.
2. `git switch -c sync/upstream-<tag>` from `main`, then `git merge --no-edit <tag>`. **Merge, never
   rebase** — published history stays walkable and upstream commit SHAs stay citable in our history.
3. **Lockfile:** `git checkout <tag> -- bun.lock && bun install && git commit`. Never hand-resolve
   `bun.lock` (P8); the workspace install rewrites the fork's half from
   `packages/storagebase-deps`.
4. `node scripts/storagebase/seam-check.mjs` — the merge may not have touched any upstream file
   outside the ledger beyond its budget.
5. The full gate: `bun run format && bun run lint && bun run typecheck && bun run knip && bun run
   chart:check && bun run channels:showcase:check && bun run readme:check && bun run security:check
   && bun run test && bun run build`.
6. Push the branch, open the PR against `main`.

## When the merge conflicts

Every conflict must be inside a SEAMS.md ledger seam — a 2-3 line call into fork code, where the
resolution is mechanical: re-apply the seam call around upstream's new code. The likely candidates,
with the conflict treatment:

- `src/lib/query-events/sink.ts` (S2): keep upstream's body; the tap stays the first line of
  `recordQueryEvent`.
- `src/lib/audit.ts` (S3): keep upstream's event shapes; the tap stays the last line of
  `emitAuditEvent`.
- `src/lib/db/providers/keyvalue/redis.ts` (S4): keep upstream's options; the sentinel spread stays
  inside the `new Redis({...})` call. The day upstream takes the Sentinel PR, delete the seam here
  and the row in SEAMS.md.
- `package.json` (S5): keep upstream's everything; the fork contributes only the `"workspaces"` line.
  Dependencies belong in `packages/storagebase-deps`, never here.
- `next.config.ts` (S6), `knip.json` (S7): keep upstream's lists; the fork's spread/entries stay.
- `bun.lock` (S10): take upstream's copy and run `bun install` (step 3).

A conflict in any other file is a **layering bug in the fork**: resolve it by moving the fork's side
under a `storagebase` path, not by hand-merging code. If that is impossible without a new upstream
edit, the new edit needs a ledger row first (owner approval), then `SEAMS.md` and the seam budget
absorb it forever after.

## What never conflicts

Every fork-owned path: `src/storagebase/**`, `src/components/storagebase/**`,
`src/app/(storagebase)/**`, `src/app/api/sb/**`, `tests/storagebase/**`, `docs/storagebase/**`,
`packages/storagebase-deps/**`, `scripts/storagebase/**`, `deploy/storagebase/**`,
`.github/workflows/storagebase-*.yml`, `STORAGEBASE.md`, `SEAMS.md`, `REFORK_ANALYSIS.md`.
If a merge ever names one of these, two fork commits disagree — resolve within fork conventions.

## After the merge lands

- Skim `git diff main@{1} main --stat` for files upstream renamed that a ledger row still points at;
  `seam-check` fails loudly on that (its ledger rows check the target exists at the new base), and the
  row is rewritten to the new path in the same PR.
- Re-check each seam's budget spend — a merge that pushes a seam over budget is the signal to spend
  its upstream-PR effort (P7) instead.

## Dry-run record

| Date | Upstream ref | Result |
|---|---|---|
| 2026-11-18 | `libredb/main` @ `c8bf0db4a` (30 commits past tag 1.3.0, dep bumps only) | **Green.** Merged into `dryrun/upstream-sync` (merge commit `d12ae517`). Exactly one conflict: `bun.lock`, resolved by S10's policy (take upstream's lockfile, `bun install` regenerates the workspace half). `package.json` (S5) and `src/lib/audit.ts` (S3) auto-merged cleanly and kept their seams within budget; no other file conflicted and no layering bug was found. Post-merge `seam-check` green against the new base (19 ledger rows, 264 changed paths, all within budget), `typecheck` green, fork suite 71 files / 745 tests green, route-auth + governance-grants 100 tests green. No seam's spend changed: the merge absorbed upstream's change into the new base without moving a fork edit. |

## Upstream PRs from this fork

- [libredb/libredb-studio#2314](https://github.com/libredb/libredb-studio/pull/2314) — Redis Sentinel connections, offered from `storagebase:upstream-pr/redis-sentinel`. When it merges, delete seam S4 from `src/lib/db/providers/keyvalue/redis.ts`, remove its `SEAMS.md` row, and keep only the fork's options builder if another deployment still needs the `redis-sentinel://` string form (otherwise remove that too).
