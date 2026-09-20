# StorageBase Studio — Session Handoff

Date: 2026-09-19. Author: recovered from V1 session `ses_f454cc909ffekMybRmZmO1u17p`
("StorageBase Studio: blobs, messaging, vaults", 2026-09-19 17:25–20:10, 214 messages).
That session lives in the legacy `session` table and is **not openable** under the V2
server (`GET /api/session/<id>` → 404; V2 reads only `session_v2`, and the one-shot
V1→V2 migration had already marked `completed` before this session was created).
This file preserves everything needed to continue. It is fork-owned (never exists
upstream) so it can never cause a merge conflict.

Related session: `ses_f454df802ffezm2SnF03FwuC1H` ("StorageBase: blob, messaging, vault
support plan") — the 1-minute planning prompt that led into the main session.

## 1. Goal (user's own words, first message)

Extend LibreDB Studio into **StorageBase Studio**:

- Blob storages: Azure Blob, S3, S3-compatible
- Messaging: Kafka, RabbitMQ, SQS
- Key vaults: AKV, Amazon KMS, HashiCorp Vault + Vault-compatible forks
- Do NOT break existing DB layers — the fork syncs DB work from upstream LibreDB
- Base: latest stable tag `0.16.0`; analysis split into tasks for parallel agents

## 2. Repo state — safe in git

Remote setup (`git remote -v`):

- `origin` → `git@github.com:storagebase/storagebase-studio.git` (true GitHub fork of upstream)
- `upstream` → `git@github.com:libredb/libredb-studio.git`

`main` is clean and synced with `origin/main`. Top of history:

- `27fd9a04` (M0) `chore(fork): bootstrap StorageBase Studio` — brand rename (UI prose only;
  package/chart/operator/env identifiers deliberately stay upstream-compatible), `STORAGEBASE.md`
  fork conventions, `docs/UPSTREAM_SYNC.md` merge runbook, `CLAUDE.md` anchor line.
- `7e78c7e2` (M1) `feat(resources): land the resource core spine` — see section 4.

Branches present: `main`, `upstream-main`, plus `upstream/*` tracking branches. No feature
branches yet — M2–M5 branches are still to be created (names in section 6).

## 3. Standing rules (from STORAGEBASE.md — the file wins on fork policy)

- **Parallel resource layer, zero edits inside `src/lib/db/`** for resource features. Resource code
  lives ONLY in: `src/lib/resources/**`, `src/app/api/resources/**`, `src/components/resources/**`,
  `docs/resources/<type-id>.md` + `tests/integration/resources/<type-id>-provider.test.ts`
  (the resource triad, 1:1 per type-id, same PR — mirrors the upstream DB triad rule).
- Importing FROM upstream modules is encouraged; editing them is forbidden, except purely
  additive one-line append-only registration entries where no alternative exists.
- **Type-ids (only list, defined by `ResourceType` union):** blob `azure-blob`, `s3`; messaging
  `kafka`, `rabbitmq`, `sqs`; vault `azure-key-vault`, `aws-kms`, `aws-secrets-manager`,
  `hashicorp-vault`, `openbao`. S3-compatibles (MinIO, R2, Spaces) are wire relatives of `s3`
  via endpoint override, not own ids. `openbao` is its own id sharing the Vault module.
- Branding vs identifiers: visible prose says StorageBase Studio; identifiers renamed only via
  the scripted M5 release-chain workstream. New fork config uses `STORAGEBASE_` env prefix.
- Upstream sync: merge `upstream/main` into `main`, never rebase published history; full gate
  before push. Accepting 0.16.0 as base leaves out ~68 `main`-ahead commits until a later sync.
- Verification gate (every milestone): `bun run format && bun run lint && bun run typecheck &&
  bun run knip && bun run test && bun run build && bun run build:lib && bun run attw`, plus
  `test:coverage && coverage:check` for new code (100% line coverage on new code), e2e smoke in
  both run modes.

## 4. M1 spine — what landed (contract everything builds on)

`src/lib/resources/`: `types.ts` (`ResourceType` ×10, `RESOURCE_CATEGORY_OF`,
`RESOURCE_TYPES`, `isResourceType`, `ResourceConnection` with endpoint-shaped addressing,
`ResourceOperation` closed union tree/blob.read/blob.download/blob.upload/blob.delete/
message.browse/message.publish/message.purge/secret.read/secret.write/secret.delete,
`ResourceProviderCapabilities`, `ResourceProviderLabels`, `ResourceNode`/`ResourceNodePage`
with `truncated`, `ResourceHealth`), `base-provider.ts`, `factory.ts` (cache + 30-min idle
eviction + one-shot test), `registry.ts` (Partial loader table — **ships empty**, families add
one entry per PR; UI picker reads the same table via `selectableResourceTypes()` so unregistered
types never render as connectable), `operations.ts`, `errors.ts`, `ui-config.ts`
(`RESOURCE_UI_CONFIG` exhaustive per type-id with distinct `text-hue-*` colors, per-type
`connectionFields`, `RESOURCE_TYPE_ORDER`, `hasSelectableResourceTypes()`).
`src/components/resources/resource-icons.tsx` holds the 10 icons.
Routes: `src/lib/api/resource-route.ts` (guard-before-parse shared handler) +
`src/app/api/resources/{meta,test,health,tree}/route.ts`, with `query` rate-limit bucket.
Storage: `resource_connections` collection + facade, 4 new credential fields in the agent
state-guard aggregate, AES-GCM coverage. Audit crossovers (additive): `RESOURCE_*` error codes +
mapper, `resource_connection_test` event, `resource_unreachable` reason. Docs triad started:
`docs/resources/README.md` + 13 test files. Gate was green at merge.

## 5. Milestone map (original plan numbering)

- M0 fork bootstrap — DONE (`27fd9a04`)
- M1 resource spine — DONE (`7e78c7e2`)
- M2 blob family: providers, routes, blob browser tab, wire-relatives table, MinIO+Azurite fixtures, triads
- M3 messaging family: Kafka/RabbitMQ/SQS providers, message viewer tab, fixtures, triads
- M4 vault family: 5 type-ids, masked secret view, write/delete, fixtures, triads
- M5 release chain: full identifier rename, 18 workflows re-pointed, drift-guard + `rename-patch.sh`

Renumber note: the session's final parallelization message re-labels the UI slice as "M2-UI"
and messaging/vaults as "M3/M4", with blob absorbed into "families". Section 6 uses that
final numbering. Within families, read paths land before write ops.

## 6. Where the work stopped — resume here

Last exchange (20:08): user asked "Which tasks can be executed parallel now?" Assistant answered
with the map below and was "setting up isolated worktrees and dispatching" — **no worktree or
branch was created** (verified: only `main`/`upstream-main` exist). Nothing after M1 is in git.

Parallel map:

- Start immediately, no ordering constraints: A. family SDK deps (`chore/resource-deps`:
  `package.json`, `bun.lock`, `tsup.config.ts`, `next.config.ts` — single owner for lockfile);
  B. compose + fixtures (`chore/resources-compose`: `resources-compose.yml`, `docker/*-init/`,
  `docs/resources/compose.md` — new files only); C. release chain/M5 (`chore/release-chain`,
  disjoint from src/tests/docs, skips package rename until A merges).
- After A lands: messaging (`feat/messaging`) and vault (+ blob) families. Firewall rule:
  **never touch shared chrome** (`ConnectionModal`, `Sidebar`, `Studio`, `QueryTab`) — that is
  the UI slice's. Viewers plug into a registry API the slice specs; families write against the
  spec and merge after it.
- Sequential, lands on `main` first, one owner: the **UI slice** — shared chrome + viewer
  registries + `resource_operation` audit type. Merge order: A → UI slice → families → C anytime.

M2-UI slice scope (designed from exploration after the session; the registry spec was never
written): category tabs + resource type picker in `ConnectionModal` (driven by
`selectableResourceTypes()`, form from `RESOURCE_UI_CONFIG.connectionFields`, test via
`/api/resources/test`, save to `resource_connections`); resource sections in
`src/components/sidebar/Sidebar.tsx` + `ConnectionsList` and tree reads via `/api/resources/tree`
(branching on `hasChildren`, never kind); Studio pane branch for resource tabs; `resource_operation`
audit event + family outcome reasons in `src/lib/audit.ts` (mirroring `object_edit`'s
decision+outcome shape); viewer registry in `src/components/resources/` that blob/messaging/vault
viewers will plug into. Keep every shared-chrome edit additive and minimal — that is the
upstream-conflict surface (`Sidebar`/modal/`Studio` + storage types).

Key chrome files: `src/components/ConnectionModal.tsx` + `src/hooks/use-connection-form.ts`
(DB-only form to mirror/extend), `src/components/sidebar/Sidebar.tsx`,
`src/components/Studio.tsx`, `src/workspace/StudioWorkspace.tsx`, upstream config analogue
`src/lib/db-ui-config.ts`, audit `src/lib/audit.ts:58,154`.

## 7. Decisions already locked

- `s3` single id with wire-relatives; no per-vendor ids.
- Kafka: no purge — declare unsupported, refuse cleanly. SQS peek: receive with visibility≈0,
  document duplication/reordering honestly.
- `amqplib` dual UMD/ESM — externalize in both configs, verify both run modes.
- No Azure Key Vault emulator — mocked tests only (documented limitation).
- Conflicts on upstream merge limited to shared UI files + storage types; new dirs never conflict.
- 100% coverage gate, strict TDD per repo rules.

## 8. Security action required

At 19:02 the session author pasted an npm token (`npm_***`) into chat. It sits in plaintext in
`~/.local/share/opencode/opencode.db` (legacy `part` rows) and log files. **Rotate/revoke it**
at npmjs.com/org/storagebase and never paste tokens into chat again (use env vars / CI secrets).

## 9. Next actions checklist

1. Rotate the npm token (section 8).
2. Create branches `chore/resource-deps`, `chore/resources-compose`, `chore/release-chain`; run A/B/C.
3. Implement the M2-UI slice on `main` (section 6), including the viewer-registry spec families need.
4. Land families (blob, messaging, vault) with triads; read paths before writes.
5. M5 release chain; re-apply `rename-patch.sh` on every upstream merge per `docs/UPSTREAM_SYNC.md`.

## 10. M2-UI slice status (2026-09-20, branch `feat/resource-ui-slice`)

Implemented, committed, unmerged. Commits on top of `7e78c7e2`:

- Audit: `resource_operation` event + `resource_denied/not_found/conflict/unsupported/failed` reasons.
- `useResourceConnectionForm` hook + `ResourceConnectionForm` + `ConnectionModal` category tabs
  (registry-gated; edits lock the dialog's other half).
- `ResourceTree` + `ResourceConnectionsList` + `Sidebar` sections (render only when wired).
- `useResourceConnections` + Studio wiring; viewer registry ships empty (`getResourceViewer`
  returns `undefined` → tree fallback).
- `docs/resources/ui-slice.md` family contract; `docs/resources/README.md` numbering fixed.

Full gate (`format`, `typecheck`, `knip`, `test`, `build`, `build:lib`, `attw`) status: see branch
log. Merge order per section 6: A → UI slice → families → C anytime. Remaining M2-adjacent work
not in the slice: persisted active-resource id, resource favorites/ordering, `onResourceNodeClick`
viewers (arrive with families).
