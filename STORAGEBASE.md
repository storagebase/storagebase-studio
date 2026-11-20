# StorageBase Studio — fork rules

This repo is the **StorageBase Studio** fork of [libredb/libredb-studio](https://github.com/libredb/libredb-studio),
cut fresh at upstream tag `1.3.0` (commit `58adba53`). `CLAUDE.md` is upstream's file and stays untouched;
**where the two disagree on fork policy, this file wins.** Fork agents read this file first.

The fork's history before the re-fork lives on branch `legacy/0.16-main` (old `main`, based on upstream
`c96bfada` ~0.16.0). That branch is the **porting source**: read old code from it with
`git show legacy/0.16-main:<path>`. Never copy an upstream-territory diff from it; re-express every feature
through the rules below.

## The one design goal

After the port, a weekly `git merge <upstream-tag>` must be **mechanical**: zero conflicts in the normal
case, and when there is one, it is inside a known, few-line seam listed in [`SEAMS.md`](SEAMS.md).
All fork value lives in files upstream does not have. Every rule below serves that goal.

## Principles (binding)

- **P1 — One fork-owned namespace.** All fork code lives under paths containing `storagebase`:
  `src/storagebase/**` (server + shared), `src/components/storagebase/**` (React),
  `src/app/(storagebase)/**` (pages), `src/app/api/sb/**` (API routes), `tests/storagebase/**`
  (tests), `docs/storagebase/**` (docs), `packages/storagebase-deps` (fork npm deps),
  `scripts/storagebase/**`, `deploy/storagebase/**`, `.github/workflows/storagebase-*.yml`,
  `vscode-extension/.vscode-test.storagebase.mjs` (a `--config` file test-cli must find beside the extension),
  plus the fork docs at the root (`STORAGEBASE.md`, `SEAMS.md`, `REFORK_ANALYSIS.md`).
  Upstream can never collide with any of these paths.
- **P2 — Upstream files are touched only through registered seams.** A seam is an edit to an upstream
  file, at most 3 added lines, whose only job is to *call into* or *import from* fork code — no logic
  inside upstream files. Every seam is a row in [`SEAMS.md`](SEAMS.md); anything not in that ledger is
  forbidden. `scripts/storagebase/seam-check.mjs` enforces it in CI and before every push.
- **P3 — Never extend an upstream closed union or registry table.** `DatabaseType`, `AuditEventType`,
  `AuditReason`, `ApiErrorCode`, `RateLimitBucket`, storage collections, `ADMIN_SECTIONS`, connection-form
  enums, seed zod schemas: none of them. The fork keeps its own equivalents in its own store and routes
  (`SB_*` error codes, `storagebase.audit.v1` vocabulary, `storagebase_*` tables), and reuses an existing
  upstream rate-limit bucket (`guardRoute({ bucket: "query" })`) instead of adding one.
- **P4 — Import upstream freely; never edit it.** `guardRoute`, `adminRequiredResponse`, `emitAuditEvent`,
  `resolveConnection`, `editorProvider`, `clientAddress`, `onShutdown`, storage encryption helpers,
  `src/components/ui/*` primitives — imports never conflict. A renamed upstream export breaks the build
  loudly, which is better than a silent merge.
- **P5 — Configuration before code.** Upstream OIDC (Entra), seed `roles:`, `readOnly`, `managed`, Vault
  references, governance settings meet most needs; code only the gap.
- **P6 — Do not rename upstream identifiers in-tree.** `@libredb/studio`, `LIBREDB_*` env vars, the
  upstream chart, workflows and Dockerfiles stay as they are. StorageBase ships through fork-owned build
  files (`deploy/storagebase/Dockerfile.storagebase`, `.github/workflows/storagebase-image.yml`, image
  `ghcr.io/storagebase/storagebase-studio`, a Helm values overlay on the upstream chart). New fork
  configuration uses the `STORAGEBASE_` prefix.
- **P7 — Upstream first.** Every fork change that is generic upstream quality (Sentinel, a pluggable
  secret resolver, an audit-sink hook, a query-event observer) is offered upstream as a PR; when it
  merges, the seam is deleted. `SEAMS.md` tracks the PR link.
- **P8 — Fork dependencies sit in `packages/storagebase-deps`** (a bun workspace; root `package.json`
  has the one-time `"workspaces": ["packages/*"]` seam). `bun.lock` is never hand-resolved: take
  upstream's lockfile, run `bun install`. Fork code is NOT part of the npm library build (`tsup.config.ts`,
  `src/exports/**` untouched). Node-only fork SDKs are externalized through one
  `STORAGEBASE_SERVER_EXTERNALS` spread in `next.config.ts`, and staged into the standalone Docker
  payload by `scripts/storagebase/stage-resource-sdks.mjs`.
- **P9 — Stub the leaf, never the callers.** To remove or replace a UI element, edit the one leaf module
  that renders it (see S8), never its callers.

## The seam ledger

The complete list of allowed upstream edits is [`SEAMS.md`](SEAMS.md). If a change seems to need an
edit outside the ledger, the design is wrong — bring the capability into the fork layer instead, or get
the owner's approval for a new ledger row.

## Fork resource triad

Fork resource types follow the same code↔docs↔tests triad rule upstream applies to engines, inside fork
namespaces, 1:1 per fork type-id:

- Code: `src/storagebase/resources/providers/<family>/<type-id>.ts`
- Docs: `docs/storagebase/resources/<type-id>.md`
- Tests: `tests/storagebase/integration/<type-id>-provider.test.ts`

The type-id set is the fork `ResourceType` union in `src/storagebase/resources/types.ts`, never prose.
Any change to one side syncs the others **in the same PR**.

## Decisions in force

From `REFORK_ANALYSIS.md` §9 (defaults, owner may revise): the fork lives in this repo
(old `main` archived as `legacy/0.16-main`); Azure Blob, Azure Key Vault, Kafka are mandatory and
HashiCorp Vault/OpenBao is ported; S3, RabbitMQ, SQS, AWS KMS, AWS Secrets Manager are deferred until
there is a user (upstream has read-only S3 and RabbitMQ DB types); access is config-only (seeds with
`roles:`), no admin access UI, no vault exclusions; AKV is a workbench only (no `${akv:…}` seam);
social/star links are stubbed out at the leaf (S8); branding depth is fork-owned build files only.

## Gates

- Every PR runs the upstream gate unchanged (`bun run format && bun run lint && bun run typecheck && bun run knip && … && bun run test && bun run build`)
  **plus** `node scripts/storagebase/seam-check.mjs`.
- **100% line coverage is a hard gate on `src/storagebase/**`** the same way it is upstream-wide: every
  change that adds or alters executable fork lines lands with its tests in the same PR, TDD.
- Upstream census tests (route-auth census, `no-engine-branches`, engine counts) must pass
  **unmodified**: fork routes call `guardRoute`, fork code never branches on an upstream engine type-id,
  and the fork adds no `DatabaseType`. If a census test needs a fork entry, that is a seam: ledger row.

## Syncing from upstream

The runbook is [`docs/storagebase/UPSTREAM_SYNC.md`](docs/storagebase/UPSTREAM_SYNC.md); the weekly
workflow is `.github/workflows/storagebase-upstream-sync.yml`. Short version: merge the newest upstream
bare-semver tag, never rebase, take upstream's `bun.lock` and run `bun install`, run seam-check and the
full gate, and expect conflicts only inside ledger seams.
