# Seam ledger

The complete list of upstream files this fork is allowed to edit, and the budget each edit may spend.
Anything not in this table is forbidden without the owner's approval and a new ledger row.
`scripts/storagebase/seam-check.mjs` enforces it: every upstream file changed vs the tracked upstream
ref must appear here, and each listed file must stay within its budget (added/removed lines vs the
merge-base). A seam's only job is to *call into* or *import from* `src/storagebase/**` — no logic
inside upstream files.

Budgets: `+N/−M` means at most N added and M removed lines vs the merge-base. `regenerated` means the
file is produced by tooling (`bun install`), never hand-resolved.

| Id | File | Budget | Edit | Why it cannot be avoided | Upstream PR | Status |
|---|---|---|---|---|---|---|
| S1 | `src/app/page.tsx` | +4/−1 | Wrap `<Studio />` in `<StorageBaseShell />` (fork section rail) + import; Biome reindents the child, hence the one removed line | The rail must sit beside the DB studio on `/` | no (product UI) | applied in phase 2 |
| S2 | `src/lib/query-events/sink.ts` | +2/−0 | First line of `recordQueryEvent`: `storagebaseQueryTap(input);` + import | The one point every statement-executing route passes through, governance or not | yes: "query event observer" | applied in phase 1 |
| S3 | `src/lib/audit.ts` | +2/−0 | End of `emitAuditEvent`: `storagebaseAuditTap(stored);` + import | Upstream events (login, logout, role denial, connection test) must reach the durable fork store | yes: "audit sink registry" | applied in phase 1 |
| S4 | `src/lib/db/providers/keyvalue/redis.ts` | +2/−0 | Spread `...storagebaseSentinelOptions(config)` into the `new Redis({...})` options + import | Sentinel must change how ioredis connects (5.5) | **PR [#2314](https://github.com/libredb/libredb-studio/pull/2314)** — delete this seam and its row when it merges | applied in phase 5 |
| S5 | `package.json` | +3/−0 | One-time `"workspaces": ["packages/*"]` | P8: fork deps sit in `packages/storagebase-deps` | no | applied in phase 0 |
| S6 | `next.config.ts` | +2/−0 | `...STORAGEBASE_SERVER_EXTERNALS` spread in `serverExternalPackages` + import | Node-only fork SDKs (Azure/Kafka) must stay out of the client bundle | no | applied in phase 0 |
| S7 | `knip.json` | +13/−1 | Workspace + entry entries for `packages/storagebase-deps` and fork paths | knip would flag fork entry points | no | applied in phase 0 |
| S8a | `src/components/github-repo-link.tsx` | +11/−47 | Render `null` (leaf stub, P9) | D5: no social links | no | applied in phase 6 |
| S8b | `src/lib/community/star-prompt-toast.ts` | +8/−43 | Both entry points inert (leaf stub, P9) | D5: no star prompt | no | applied in phase 6 |
| S8c | `src/components/community-section.tsx` | +10/−109 | Render `null` (leaf stub, P9) | D5: no social links on the login hero either | no | applied in phase 6 |
| S8d | `tests/components/GitHubRepoLink.test.tsx` | +11/−95 | Assert the stub renders nothing | A stub's direct test cannot keep asserting the removed behaviour | no | applied in phase 6 |
| S8e | `tests/components/CommunitySection.test.tsx` | +9/−92 | Assert the stub renders nothing | Same as S8d | no | applied in phase 6 |
| S8f | `tests/unit/lib/community/star-prompt-toast.test.ts` | +18/−103 | Assert both entry points are inert | Same as S8d | no | applied in phase 6 |
| S9 | `src/lib/seed/credential-resolver.ts` | +3/−0 | `${akv:…}` references | Only if AKV must feed *connection credentials* (D4) | **yes, first choice**: "pluggable secret resolver" | **reserved, not applied** (D4 default: workbench only) |
| S10 | `bun.lock` | regenerated | Take upstream's lockfile, run `bun install` | Lockfile policy (P8); never hand-resolved | no | permanent |
| S11 | `CLAUDE.md` | +2/−0 | One anchor line after the header pointing fork agents at `STORAGEBASE.md` | Fork agents must discover the fork rules; upstream's file says nothing about them | no | applied in phase 0 |
| S12 | `tests/unit/db/kafka/seam-guard.test.ts` | +6/−2 | Add the fork's kafka client (`src/storagebase/resources/providers/messaging/kafka-client.ts`) to `IMPORTERS` and `LOADER_TAKERS` | The census pins exactly which files may import `@platformatic/kafka` or take `loadPlatformatic`; the fork's separate write-capable client is one more importer (5.4) | no (fork constraint; upstream's two importers stay unchanged) | applied in phase 4 |
| S13 | `tests/unit/lib/no-engine-branches.test.ts` | +39/−0 | Six `REGISTRIES` entries for the fork's compile-enforced `ResourceType` tables | The census scans all of src/ and its type-id set includes `kafka`, a fork type-id too; the fork's registry tables are the same mapping class upstream's REGISTRIES lists, so they need the same held entries | no | applied in phase 2 |
| S14 | `tests/security/helpers/provider-routes.ts` | +48/−0 | Classify the fork's `/api/sb/**` routes in `PROVIDER_ROUTES_WITHOUT_A_CONNECTION_BODY` | The governance-grants inventory requires EVERY guardRoute-using route be classified as resolving an upstream connection or named with a reason; fork routes resolve through the fork store/seed instead | no | applied in phase 2 |
| S15 | `tests/components/sidebar/Sidebar.test.tsx` | +4/−7 | Assert no repository link in the footer | The test asserted the link the S8a stub removes | no | applied in final gate |
| S16 | `tests/components/studio/StudioDesktopHeader.test.tsx` | +9/−14 | Assert no repository link/star handling in the desktop header | Same as S15 | no | applied in final gate |
| S17 | `tests/components/studio/StudioMobileHeader.test.tsx` | +9/−12 | Assert no repository link/star handling in the mobile header | Same as S15 | no | applied in final gate |
| S18 | `tests/hooks/use-query-adapter.test.ts` | +12/−14 | Assert no star invitation from the embedded query path | The test asserted the toast the S8b stub removes | no | applied in final gate |
| S19 | `tests/hooks/use-query-execution.test.ts` | +8/−9 | Assert no star invitation from the standalone query path | Same as S18 | no | applied in final gate |
| S20 | `tests/unit/lib/passkey/management.test.ts` | +17/−9 | Filter the fork's `storagebase.audit.v1` stdout lines out of the upstream `libredb.audit.v1` assertion | The S3 tap mirrors upstream events into the fork sink, whose own stdout line is counted by the test's broad `event:"account"` filter under coverage | no | applied in final gate |
| S21 | `tests/unit/test-runner-discovery.test.ts` | +13/−1 | Name `storagebase` as a test-runner layer | The fork's `tests/storagebase/**` must be discoverable by the runner census, which enumerates layers explicitly | no | applied in final gate |
| S22 | `tests/unit/helm-pin-matrix.test.ts` | +12/−6 | Count the fork CI's setup-helm site as the ninth | `storagebase-ci.yml:test` is a new, pinned setup-helm site; the census enumerates all of them | no | applied in final gate |
| S23 | `tests/security/kubernetes-access-callers.test.ts` | +10/−0 | Allow the fork's computed SDK import and the Kafka route's `resolveConnection` call | The census enumerates every such caller repo-wide; these two fork callers are legitimate and named with reasons | no | applied in final gate |
| S24 | `.env.example` | +6/−0 | Document `STORAGEBASE_AUDIT_RETENTION_DAYS` and `STORAGEBASE_RESOURCE_SEED_PATH` | Every env var must have an example; fork-only config uses the `STORAGEBASE_` prefix (P6) | no | applied in final gate |
| S25 | `docs/BACKLOG.md` | +3/−2 | Update D85's auth-mock count for the fork's ported helpers | The count is measured by a structural guard and the fork's `tests/storagebase/**` helpers changed it; upstream re-measured the same paragraph, so the merge leaves a fork-side line on top of theirs | no | applied in final gate |
| S26 | `docs/SECURITY.md` | +6/−3 | Add the three fork routes that call `auditRoleDenial` to the role-denial table | The table is compile-checked against every call site; fork routes are new call sites | no | applied in final gate |
| S27 | `tests/unit/security-role-denial-table.test.ts` | +3/−0 | Extend the number-word table to fifteen | With the fork's three new call sites the count is fourteen; the test spells counts out in words | no | applied in final gate |
| S28 | `bin/lib/launcher-utils.mjs` | +2/−0 | Classify `STORAGEBASE_RESOURCE_SEED_PATH` as a path variable | The launcher-utils census requires every `*_PATH` var in `.env.example` be classified; the server reads this one like `SEED_CONFIG_PATH` | no | applied in final gate |
| S29 | `tests/unit/lib/query-events/sink.test.ts` | +3/−0 | Stub the fork's S2 tap in this upstream sink unit test | S2 arms a second, fork-owned sink; this file's timer-count and warning assertions own only the upstream sink, so the fork tap must not run here | no | applied in final gate |
| S30 | `bunfig.toml` | +8/−0 | Pin `[install] linker = "hoisted"` | The S5 workspace seam makes bun default to the isolated linker, which breaks upstream dependency-resolution tests that resolve transitive packages (`fzstd`, `ajv-draft-04`) from a symlinked manifest; hoisted is upstream's measured layout | no | applied in final gate |
| S31 | `tests/unit/lib/query-events/postgres-sink.test.ts` | +3/−0 | Stub the fork's S2/S3 taps in this upstream sink unit test | The taps arm a second, fork-owned sink whose stdout lines would join the `console.log` spy this file asserts on | no | applied in final gate |

## Explicitly not seams (the old fork edited them; this fork must not)

`src/lib/types.ts`, `db-ui-config.ts`, `use-connection-form.ts`, `use-connection-payload.ts`,
`ConnectionModal.tsx`, `seed/types.ts`, `seed/connection-filter.ts`, `agent/context-snapshot.ts`,
`db/connection-fingerprint.ts` (Sentinel travels inside a connection string, see 5.5) ·
`db/factory.ts` (the old cache-invalidation fix is obsolete: upstream's `provider-cache-key.ts` keys on
id + fingerprint + credential digest + read-only mode) ·
`Studio.tsx`, `Sidebar.tsx`, `SchemaDiagram.tsx` (ERD toggle → upstream PR only; Redis dock → dropped,
upstream ships a generic `src/components/key-browser/KeyBrowser.tsx`) ·
`storage/{types,storage-facade,encrypting-provider,connection-secrets,factory}.ts`, `use-storage-sync.ts`
(resource connections live in the fork store) ·
`api/errors.ts`, `api/error-codes.ts`, `api/rate-limit.ts` (fork-local `SB_*` codes, existing bucket) ·
`instrumentation.ts` (fork taps initialise lazily) ·
`app/api/db/{query,multi-query,transaction}/route.ts` and `objects/*` (S2 replaces per-route audit;
DB access control is upstream config: seeds, `roles:`, `readOnly`, `managed`) ·
`admin-sections.ts`, `AdminDashboard.tsx`, `AuditTab.tsx`, `OverviewTab.tsx`, `app/api/admin/audit/route.ts`
(fork admin pages at `/sb-admin/*`, linked from the rail) ·
`auth.ts`, `login/*`, `api/auth/*` (upstream OIDC covers Entra sign-in) ·
all branding and rename files: `charts/`, `operator/`, `packaging/`, `deploy/`, `desktop/`, `snap/`,
`distribution/`, `bin/`, `fly.toml` (P6).

## Census tests

Upstream census tests that enumerate the tree (route-auth census, `no-engine-branches`, coverage gate)
pass **unmodified**. Fork routes satisfy them by construction: every `src/app/api/sb/**` route calls
`guardRoute`, no fork code branches on an engine type-id outside provider files, and coverage is 100% on
`src/storagebase/**`. If a census test still needs a fork entry, that is a seam: add a ledger row first.

## Keeping this file honest

`node scripts/storagebase/seam-check.mjs` (CI + pre-push):
1. Diffs `HEAD` against the merge-base with the tracked upstream ref (`STORAGEBASE_UPSTREAM_REF`,
   default `libredb/main`), filtered to paths that exist upstream.
2. Every changed upstream path must appear in this table, else fail.
3. Per ledger file, the diff must stay within the budget, else fail.
4. Prints the table with each file's current upstream churn (commits in the last 60 days).
