# Upstream sync runbook

StorageBase Studio tracks `libredb/libredb-studio` for everything database-related. This is the
repeatable procedure for pulling their work in.

## Remotes

- `origin` → `git@github.com:storagebase/storagebase-studio.git` (the fork; `main` is the product
  branch, cut from upstream tag `0.16.0`)
- `upstream` → `git@github.com:libredb/libredb-studio.git`

## Procedure

1. `git fetch upstream --tags`
2. `git merge upstream/main` (merge, never rebase — published history stays walkable, and upstream
   commit SHAs stay citable in our history)
3. Expect conflicts only in files both sides touch. In rough likelihood order:
   - Shared UI files both sides edit: `src/components/Studio.tsx`, `src/components/sidebar/*`,
     `src/components/ConnectionModal.tsx`, `src/hooks/use-connection-form.ts`, `src/lib/types.ts`.
     Resolve by keeping BOTH: upstream's database behaviour plus the fork's additive resource fields
     and branches. Resource additions are always optional fields / additive branches — if a merge
     cannot preserve both sides, that is a bug in our layering; fix the layering, not the merge.
   - Brand strings in files renamed in M0 (layout, login form, sidebar header, startup banner,
     auth-bootstrap / agent-config / auth-preflight messages, `bin/studio.js`,
     `bin/lib/launcher-utils.mjs`) and their tests. Resolve to StorageBase Studio.
   - Registration tables (`src/lib/storage/types.ts` collections, rate-limit census comment in
     `src/lib/api/rate-limit.ts`). Keep both sides' rows; the census comment must be re-verified
     against the actual `guardRoute` call sites after the merge.
4. If the release-chain workstream has landed (package/chart/operator identifiers renamed to
   storagebase), run `./scripts/rename-patch.sh` and commit what it reapplies.
5. Run the full gate:
   `bun install && bun run format && bun run lint && bun run typecheck && bun run knip && bun run chart:check && bun run channels:showcase:check && bun run readme:check && bun run security:check && bun run test && bun run build`
6. Push `main`. Tag releases only through the release runbook, never as part of a sync.

## What will never conflict

Every path in the fork's parallel layer is upstream-absent: `src/lib/resources/**`,
`src/app/api/resources/**`, `src/components/resources/**`, `docs/resources/**`,
`tests/integration/resources/**`, `resources-compose.yml`, `STORAGEBASE.md`, this file. If a merge
conflict names one of these, someone edited it from two places in the fork — resolve within the
fork's own conventions.

## Timing guidance

Sync when upstream cuts a release tag that contains something wanted (their tags are bare semver,
no `v` prefix). Diff first with `git log --oneline main..upstream/main` and skim
`git diff --stat main...upstream/main -- src/lib/db src/app/api/db` — database-layer changes merge
quietly; UI-layer changes are where the merge attention goes.
