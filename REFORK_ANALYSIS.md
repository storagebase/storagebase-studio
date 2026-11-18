# StorageBase Studio re-fork: analysis and target architecture

Audience: the agent that creates the new fork of `libredb/libredb-studio` and ports the
StorageBase features onto it. Written 2026-11-13 from `libredb/main` @ `2bde5f99` (1.3.0) and the
old fork `storagebase/storagebase-studio` `origin/main` @ `0c2bda12` (based on upstream `c96bfada`,
~0.16.0). Read it fully before the first commit. Re-verify any fact marked **verify** against the
upstream ref you actually start from.

---

## 1. Why a re-fork, and what goal everything below serves

The old fork is 40 commits ahead and **1326 commits behind** upstream. It changed 337 upstream
files, many of them upstream's hottest files. A merge today is a multi-day conflict job, and
upstream ships about one minor release per week (12 tags in 60 days, ~24 commits/day).

**The single design goal:** after the port, a weekly `git merge <upstream-tag>` must be mechanical:
zero conflicts in the normal case, and when there is one, it is in a known, few-line seam.
All fork value lives in files upstream does not have.

Features that must survive (owner's list):

1. Kafka workbench in the style of kafbat/kafka-ui (old fork: topics, messages, produce,
   consumer groups, lag, offset reset, brokers).
2. Auditability: who ran which query or operation, when, from where, with masked statements,
   a durable store and an admin search UI.
3. Azure Blob Storage.
4. Azure Key Vault (secrets, keys, certificates, soft-delete and recovery).
5. Redis Sentinel connections.

Also present in the old fork; the owner decides whether each survives (section 9): Entra sign-in
and the access model (groups, app-role bindings, managed connections), the section rail, vault
exclusions, server-held user secrets, S3/RabbitMQ/SQS/AWS KMS/AWS Secrets Manager/HashiCorp
Vault/OpenBao providers, branding and identifier rename, removal of social links.

---

## 2. Facts about upstream 1.3.0 that drive the design

### 2.1 No extension mechanism exists

Upstream has no plugin, hook, self-registration or event-bus system for providers, UI, auth,
audit sinks or secret stores. `plugins/` is only a Claude Code plugin. Everything registers in
hand-edited, compiler-checked tables.

### 2.2 A new `DatabaseType` costs about 30 hot upstream files

- `DatabaseType` in `src/lib/types.ts` is a closed literal union, so module augmentation cannot
  extend it.
- The latest provider commit (sparkplug, `46b449c7`) touched 142 files. Outside its own
  directory it edited:
  - `src/lib/types.ts`, `src/lib/db/types.ts`
  - `src/lib/db/factory.ts` (a `switch` of dynamic imports)
  - `src/lib/db/compatibility.ts` (~15 exhaustive `Record<DatabaseType, …>` tables)
  - `db-ui-config.ts`, `db-icons.tsx`, `db-showcase.ts`, `query-dialects.ts`,
    `dialect-editors.ts`, `fence-tags.ts`, `seed/types.ts` (hand-written zod enum),
    `agent-manifest.ts`, and about 30 census and golden tests
  - README translations, `Chart.yaml` and marketplace listings, whose engine counts are
    test-enforced
- `tests/unit/lib/no-engine-branches.test.ts` forbids `=== '<type-id>'` branches outside the
  provider layer.

**Consequence:** the fork never adds a `DatabaseType`. Everything new lives in a parallel layer,
the same structural rule the old fork had (`STORAGEBASE.md`), applied more strictly.

### 2.3 Upstream churn on the files the old fork edited

Commits in the 60 days to 2026-11-12:

| File | Commits | Old fork edited it for |
|---|---:|---|
| `src/lib/db/compatibility.ts` | 118 | – |
| `src/lib/db/types.ts` | 97 | – |
| `src/lib/db/factory.ts` | 76 | cache invalidation |
| `src/lib/types.ts` | 67 | Sentinel fields, `savedSecrets` |
| `package.json` | 58 | SDK deps, rename |
| `src/lib/seed/types.ts` | 51 | Sentinel, app roles |
| `src/hooks/use-connection-form.ts` | 50 | Sentinel |
| `src/components/Studio.tsx` | 46 | ERD, Redis dock, user connections |
| `src/lib/db-ui-config.ts` | 41 | Sentinel |
| `src/components/ConnectionModal.tsx` | 29 | Sentinel, saved secrets |
| `src/lib/db/providers/keyvalue/redis.ts` | 27 | Sentinel |
| `src/components/sidebar/Sidebar.tsx` | 21 | ERD, social links |
| `src/lib/audit.ts` | 18 | event types, fields, sink |
| `src/lib/seed/credential-resolver.ts` | 15 | Sentinel |
| `src/lib/api/rate-limit.ts` | 11 | census comment |
| `src/lib/auth.ts`, `src/lib/api/error-codes.ts` | 10 each | Entra, error codes |
| `src/lib/storage/types.ts` | 5 | `resource_connections` |
| `src/instrumentation.ts` | 4 | audit sink install |
| `src/app/page.tsx`, `src/lib/query-events/sink.ts`, `src/lib/admin-sections.ts` | 1 each | rail / – / access |

Quiet files are good seams; hot files are not.

### 2.4 What upstream already covers

This changes what to port:

| Area | Upstream 1.3.0 | Consequence |
|---|---|---|
| Kafka | `stream/kafka` is a read-only DB provider on `@platformatic/kafka` 2.14.0: topics, partitions, brokers, configs, consumer groups with lag, message reads by offset or timestamp. No produce, offset reset, topic admin, SASL OAUTHBEARER/GSSAPI or Schema Registry decoding. | Keep the fork's write-capable workbench as a separate page. Reuse upstream's connection record and client library (5.4). |
| RabbitMQ, S3 | Read-only DB providers | Duplicates of the fork's read paths |
| Redis | `keyvalue/redis.ts` (single `new Redis({...})` at ~L1565). **No Sentinel.** `redis://` and `rediss://` connection strings via `redis-connection-string.ts`. | Sentinel stays a fork feature, best taken upstream (5.5). |
| Redis key browser | Generic `src/components/key-browser/KeyBrowser.tsx` | Drop the fork's Redis key-browser dock (**verify** parity). |
| Provider cache | `src/lib/db/provider-cache-key.ts` keys on id + connection fingerprint + credential digest + read-only mode (GHSA-3wh2-8x78-jfw4) | The fork's cache-invalidation exception is **obsolete**. Do not port it. |
| Read-only connections | `readOnly: true` mode (#1089), its own provider pool | Use it for read-only grants on databases instead of the fork's statement classifier. |
| Secrets for connections | HashiCorp Vault KV v2 references `${vault:<mount>/data/<path>#<key>}` in seed connections (`src/lib/seed/vault-client.ts`). Token or Kubernetes auth. Prefix hard-coded, no resolver registry. | AKV references need a seam or an upstream PR (5.4). |
| Auth | OIDC (`NEXT_PUBLIC_AUTH_PROVIDER=oidc`), documented for Entra in `docs/OIDC.md`. `OIDC_ROLE_CLAIM=roles`, `OIDC_ADMIN_ROLES` / `OIDC_USER_ROLES` / `OIDC_ROLE_PREFIX`. Seed connections carry `roles:` and are filtered server-side. Credentials never leave the server for `managed: true`. Also passkeys, TOTP, local accounts. | Entra sign-in plus app-role gating of preconfigured DB connections needs **no fork code** (section 6). |
| Audit | `emitAuditEvent` → 1000-event in-memory ring + stdout JSON (`libredb.audit.v1`), never records SQL. `query_execution` is never emitted. `src/lib/query-events/` records statements (`none` / `redacted` / `full` capture), but only when `GOVERNANCE_SOURCE=postgres`. `recordQueryEvent()` returns early otherwise (see the `recordQueryEvent` function in `src/lib/query-events/sink.ts`). Callers: `db/query`, `multi-query`, `transaction`, `maintenance`, `profile`, `keys/scan`, `objects/edit-apply`. | One seam in `recordQueryEvent` gives the fork every statement from every route (5.2). |
| Library surface | `@libredb/studio` npm package (`src/exports/*`, `StudioWorkspace`) | Not enough for a full app (admin, auth, routes). Stay a source fork. |

---

## 3. Architecture principles (binding for the new fork)

**P1. One fork-owned namespace, named so upstream can never collide.** All fork code lives under
paths containing `storagebase`. The old fork used `src/lib/resources/**`; upstream could create
that path any day.

```
src/storagebase/                     # all fork server+shared code (was src/lib/resources, access, fork-store, audit-sql…)
  core/        seams.ts (the only module upstream seams import), env.ts, sdk-loader.ts
  store/       durable fork store (own tables; sqlite/postgres from STORAGE_* env)
  audit/       tap, masker, durable sink, query API
  resources/   spine: types, factory, registry, ui-config, operations, errors
    providers/ blob/azure-blob.ts, vaults/azure-key-vault.ts, messaging/kafka.ts, …
  access/      (if kept) groups, bindings, permissions, guards
  redis-sentinel/ options builder used by the redis seam
src/components/storagebase/          # all fork React (sections rail, workbenches, browsers, admin panels)
src/app/(storagebase)/               # fork pages: /storage /messaging /vaults /sb-admin/*  (route group, new files)
src/app/api/sb/                      # every fork API route (new files)
tests/storagebase/                   # every fork test (unit, api, integration, components, security)
docs/storagebase/                    # fork docs, triads: docs/storagebase/resources/<type-id>.md
packages/storagebase-deps/           # bun workspace package holding the fork's npm dependencies (P8)
STORAGEBASE.md  SEAMS.md  docs/storagebase/UPSTREAM_SYNC.md
.github/workflows/storagebase-*.yml  # fork CI, sync bot, image build
deploy/storagebase/                  # Dockerfile.storagebase, Helm values overlay
scripts/storagebase/                 # seam-check, sync helpers
```

**P2. Upstream files are touched only through registered seams.**
- A seam is an edit to an upstream file. It is at most 3 lines, and its only job is to *call
  into* or *import from* `src/storagebase/core/seams.ts`. No logic inside upstream files.
- Every seam is listed in `SEAMS.md` (section 4), with file, anchor, purpose, upstream churn and
  upstream-PR status.
- `scripts/storagebase/seam-check.mjs` enforces the ledger (section 7).

**P3. Never extend an upstream closed union or registry table.**
- Unions and tables: `DatabaseType`, `AuditEventType`, `AuditReason`, `ApiErrorCode`,
  `RateLimitBucket`, `STORAGE_COLLECTIONS`, `ADMIN_SECTIONS`, `CONNECTION_FORM`, seed zod enums,
  `EDITOR_LANGUAGES`.
- The fork keeps its own equivalents: its own error codes in its own routes, its own audit
  vocabulary in its own store, and its own tables via `src/storagebase/store`. Fork routes reuse
  an existing rate-limit bucket (`guardRoute({ bucket: "query" })`).
- The old fork added `resource_connections` to upstream storage and edited 6 storage and sync
  files to do it. Do not repeat that. Store resource connections in the fork store, encrypted by
  *importing* upstream's crypto helpers.

**P4. Import upstream freely; never edit it.** These are the reuse points:
- `guardRoute`, `adminRequiredResponse`, `auditRoleDenial` (`src/lib/api/require-session.ts`)
- `resolveConnection` (`src/lib/seed/resolve-connection.ts`), `editorProvider` /
  `cachedEditorProvider`, `createDatabaseProvider`
- `emitAuditEvent`, `clientAddress`, `onShutdown`, storage encryption helpers, UI primitives
  (`src/components/ui/*`)

Imports never conflict. If an upstream export is renamed, the build breaks loudly, which is
better than a silent merge.

**P5. Configuration before code.** Use upstream OIDC, seeds, `roles:`, `readOnly`, `managed`,
Vault references and governance settings wherever they meet the need. Code only the gap.

**P6. Do not rename upstream identifiers in-tree.** The old fork's M5 rename edited every file
under `charts/ operator/ packaging/ deploy/ desktop/ snap/ distribution/ .github/ bin/ scripts/`
plus `package.json`, `fly.toml` and others, about 300 files of guaranteed conflicts.
- Keep `@libredb/studio`, `LIBREDB_*` and the upstream chart and workflows untouched.
- Ship StorageBase through fork-owned build files: `deploy/storagebase/Dockerfile.storagebase`,
  `.github/workflows/storagebase-image.yml` (image `ghcr.io/<org>/storagebase-studio`), and a Helm
  values overlay on the upstream chart.
- New config uses the `STORAGEBASE_` prefix.

**P7. Upstream first.** Every fork change that is generic upstream quality (Sentinel, a
secret-resolver registry, an audit sink hook, a query-event tap, the OpenSearch date-format
fallback, the ERD toggle) is offered upstream as a PR. When it merges, the seam is deleted.
`SEAMS.md` tracks the PR link.

**P8. Fork dependencies sit in a workspace package.**
- Add the fork SDKs to `packages/storagebase-deps/package.json`.
- Root `package.json` gets a one-time `"workspaces": ["packages/*"]` seam.
- `bun.lock` conflicts are never hand-resolved: take upstream's lockfile and run `bun install`.
- `next.config.ts` gets one seam line spreading `STORAGEBASE_SERVER_EXTERNALS` into
  `serverExternalPackages`.
- Fork code is not part of the npm library build (`tsup.config.ts`, `src/exports`). Do not
  touch them.
- **Verify** early that Next's standalone output traces workspace-hoisted packages. If it does
  not, keep the old fork's `stage-resource-sdks.mjs` step in `Dockerfile.storagebase`.

**P9. Stub the leaf, never the callers.** To remove or replace a UI element, edit the one leaf
module that renders it, not its N callers.
- Example: make `src/components/github-repo-link.tsx` render `null`, and make the star-prompt
  function in `src/lib/community/star-prompt-toast.ts` return early.
- The old fork edited 8 hot callers (Sidebar, both headers, login form, error page, two hooks,
  startup banner) and deleted the modules. That conflicts on every sync.

---

## 4. The seam ledger (complete list of allowed upstream edits)

Anything not in this table is forbidden without the owner's approval and a new ledger row.

| # | File (60-day churn) | Edit | Why it cannot be avoided | Upstream PR |
|---|---|---|---|---|
| S1 | `src/app/page.tsx` (1) | Wrap `<Studio />` in `<StorageBaseShell>` (section rail). 2 lines. | The rail must sit beside the DB studio on `/`. | no (product UI) |
| S2 | `src/lib/query-events/sink.ts` (1) | First line of `recordQueryEvent`: `storagebaseQueryTap(input);` + import | The only point every statement-executing route passes through, governance or not. | yes: "query event observer" |
| S3 | `src/lib/audit.ts` (18) | One line at the end of `emitAuditEvent`: `storagebaseAuditTap(stored);` + import | Upstream events (login, logout, role denial, connection test) must reach the durable store. The tap never throws (wrap in try/catch inside the fork). Optional: without it, upstream events still reach stdout → log pipeline. | yes: "audit sink registry" |
| S4 | `src/lib/db/providers/keyvalue/redis.ts` (27) | One spread in the options passed to `new Redis({...})`: `...storagebaseSentinelOptions(config)` + import | Sentinel must change how ioredis connects. See 5.5 for how the config reaches it. | **yes, first choice**. The seam exists only until it merges. |
| S5 | `package.json` (58) | One-time `"workspaces": ["packages/*"]` | P8 | no |
| S6 | `next.config.ts` | One spread in `serverExternalPackages` | Node-only Azure/Kafka SDKs must stay out of the client bundle. | no |
| S7 | `knip.json` | Entries for `src/storagebase/**`, `packages/storagebase-deps` | knip would flag fork entry points. | no |
| S8 | `src/components/github-repo-link.tsx`, `src/lib/community/star-prompt-toast.ts` (leaf modules) | Render `null` / return early (P9) | Only if the owner keeps "no social links" (D5). | no |
| S9 | `src/lib/seed/credential-resolver.ts` (15) | `${akv:…}` references, *only* if D4 says AKV must feed connection credentials | Vault prefix is hard-coded, with no registry. | **yes, first choice**: "pluggable secret resolver" (a registry plus Vault as its first entry) |

Explicitly **not** seams any more (the old fork edited them, the new fork must not):
- `src/lib/types.ts`, `db-ui-config.ts`, `use-connection-form.ts`, `use-connection-payload.ts`,
  `ConnectionModal.tsx`, `seed/types.ts`, `seed/connection-filter.ts`,
  `agent/context-snapshot.ts`, `db/connection-fingerprint.ts` (Sentinel, see 5.5)
- `db/factory.ts` (obsolete cache fix)
- `Studio.tsx`, `Sidebar.tsx`, `SchemaDiagram.tsx` (ERD toggle → upstream PR only; Redis dock →
  dropped)
- `storage/{types,storage-facade,encrypting-provider,connection-secrets,factory}.ts`,
  `use-storage-sync.ts` (fork store instead)
- `api/errors.ts`, `api/error-codes.ts`, `api/rate-limit.ts` (fork-local codes, existing bucket)
- `instrumentation.ts` (the S3 tap initialises lazily)
- `app/api/db/{query,multi-query,transaction}/route.ts` and `objects/*` (S2 replaces the per-route
  audit calls; DB access control is upstream config, section 6)
- `admin-sections.ts`, `AdminDashboard.tsx`, `AuditTab.tsx` (+484 lines in the old fork),
  `OverviewTab.tsx`, `app/api/admin/audit/route.ts` (fork admin pages at `/sb-admin/*`, linked
  from the rail)
- `auth.ts`, `login/*`, `api/auth/*` (upstream OIDC)
- all branding and rename files (P6)

Tests: upstream census tests that enumerate the tree (route-auth census, `no-engine-branches`,
coverage gate) must pass **unmodified**. Write fork routes so they satisfy them: every route
calls `guardRoute`, there are no engine branches outside fork provider files, and coverage is
100% on `src/storagebase/**`. If a census test still needs a fork entry, that is a seam: add a
ledger row.

---

## 5. Module designs

### 5.1 Resource spine (foundation for blob, vault and messaging)

Port the old fork's spine (`src/lib/resources/{types,base-provider,factory,registry,ui-config,
operations,errors,sdk-loader}`, `src/lib/api/resource-route.ts`) into `src/storagebase/resources`
with these changes:

**Storage.** Resource connections live in the fork store (`storagebase_resource_connections`
table), not in upstream `StorageData`.
- Secret fields (`clientSecret`, `token`, `secretAccessKey`, `sessionToken`, `accountKey`,
  `connectionString`) are sealed with upstream's AES-GCM helper by import.
- Browser state holds ids only. Credentials never reach the browser: the server-held-secrets
  model the old fork had for user connections becomes the default for every resource connection.

**Preconfigured resource connections.** Add a fork seed file `STORAGEBASE_RESOURCE_SEED_PATH`,
YAML in the same shape as upstream seeds:
- `id`, `type`, `name`, `roles:`, `group`, `environment`, fields
- `${vault:…}` / `${env:…}` values resolved by *calling* upstream's resolver functions
- `roles:` matched against the session's OIDC claim roles with upstream's `seedRolesOf()`

This replaces the DB-stored managed resource connections, unless D3 keeps the admin UI.

**Request handling.** Keep `handleResourceRequest` (guard → parse → resolve). Return fork error
codes (`SB_RESOURCE_*`) from fork routes, and reuse the `query` rate-limit bucket.

**Registry.** Keep the registry static (one import line per type in a fork file; fork-only, so
conflict-free). A type is selectable only when registered.

### 5.2 Audit

**Capture**
- S2 hands the fork every `QueryEventInput`: session subject and username, role, connection,
  engine, source route, statement, row count, error, client IP, correlation id.
- **Verify** the exact `QueryEventInput` fields at the start ref.
- The fork masks the statement with its own `audit-sql` masker (port `src/lib/audit-sql.ts`).
  Alternatively it can call upstream's `buildQueryEvent` with a `redacted` policy, to get
  upstream's masking plus SHA-256 fingerprint for free. Prefer upstream's redaction if it covers
  the same dialects; keep the fork masker only for the gaps (JSON/Mongo values, Redis args).
- This replaces the old fork's per-route `startQueryAudit` edits and also covers `transaction`,
  `maintenance`, `profile`, `keys/scan` and `edit-apply`, which the old fork missed.
- S3 hands the fork every upstream audit event (auth, role denials, admin actions).
- Fork resource operations call the fork audit API directly. Port `resource-audit.ts`: the
  decision + outcome pair with a correlation id, counts only, never values. Port the full
  `resource_operation` action vocabulary (Kafka `kafka.*`, vault `vault.*`, blob `blob.*`).

**Request context.** Port `audit-request.ts`: IP via upstream `clientAddress`, plus XFF and
user-agent when `TRUST_PROXY_HEADERS` is on.

**Event schema.** The fork's own `storagebase.audit.v1` with the old fork's extended fields:
`connectionId`, `engine`, `host`, `database`, `statementKind`, `statement` (masked),
`statementTruncated`, `rowsReturned`, `rowsAffected`, `error` (masked), `queryId`, `counts`,
`authProvider`, `subject`, `appRoles`, `permission`, `grantedBy`, `accessGroups`, `ip`,
`forwardedFor`, `userAgent`.
- Written to the fork store table `storagebase_audit_events` (port `src/lib/fork-store/**`:
  retention `STORAGEBASE_AUDIT_RETENTION_DAYS`, hourly prune).
- Also written as one stdout JSON line, so the cluster log pipeline (Graylog / Elastic SIEM)
  gets it without the database.

**Reading it.** A fork admin page `/sb-admin/audit`, a port of the old fork's AuditTab extensions
as a standalone page:
- filters: type, action, user, IP, engine, time range, text
- cursor paging, export of up to 50k rows, a detail drawer
- `/sb-admin/*` is admin-only. **Verify** that `src/proxy.ts` covers it; if it only matches
  `/admin`, guard each page and route with `adminRequiredResponse()`, which needs no seam.

Leave upstream's Admin > Audit tab as it is.

**Invariants to keep from the old fork's tests.** Port `tests/security/{query,resource,vault}-
audit-redaction.test.ts`:
- no secret values, credentials or unmasked literals in any audit sink
- every tap is try/catch-wrapped, so audit failure never fails a query

### 5.3 Azure Blob (`azure-blob`) and Azure Key Vault (`azure-key-vault`)

**Code.** Port the providers (`blob/azure-blob.ts` 412 LOC, `vaults/azure-key-vault.ts` 674
LOC), their routes (`/api/sb/blob/*`, `/api/sb/vault/*`) and their UI (`BlobBrowser`,
`VaultWorkbench`, `SecretValue`, `SecretForm`, `KeyCreateForm`, `CertificateImportForm`,
`VaultDeletedList`) almost as they are. Move them only by path.

**Gaps to close while porting** (ADX runs on AKS):
- **Workload identity / managed identity.** Add an auth mode `workload-identity` using
  `@azure/identity` `WorkloadIdentityCredential` / `ManagedIdentityCredential`. Make it the
  default for in-cluster deployments, so no client secret sits in the connection.
- Blob only:
  - SAS URL / account SAS
  - connection string
  - upload streaming instead of base64 JSON (the old cap was 10 MiB)
- Keep the old guarantees:
  - reveal is the only value-reading route, with `Cache-Control: no-store`
  - details come from version properties only
  - masked UI that never pre-fills
  - purge needs `admin` plus confirmation by name
  - soft delete and recover

**Vault exclusions.** Keep them if D3 keeps the access model. They are fork-only already
(`vault-exclusions*.ts`, `ExcludingVaultWorkbench`), so they cost no seams.

### 5.4 Kafka workbench

**Page.** Port `KafkaWorkbench` and its panels (topics, topic detail, config, messages, groups,
group detail, brokers) and the 15 routes as `/api/sb/kafka/*`. Keep the permission split:
- **read:** cluster, topics, counts, topic detail, messages, groups, lag, group detail
- **write:** create topic, add partitions, alter config, produce
- **admin:** delete topic, reset offsets, delete group

**Change 1: one connection record for Kafka.** Upstream now has a `kafka` DB type, with seeds,
`roles:`, Vault refs, managed credentials and `readOnly`. The workbench resolves its connection
through upstream's `resolveConnection()` (import, no seam) from an upstream `kafka` connection.
It does **not** keep a second Kafka record in the fork store.
- One definition then shows up both in upstream's read-only explorer and in `/messaging`.
- `readOnly: true` on the connection forces the workbench read-only.
- **Verify** that `resolveConnection` returns the decrypted connection server-side for a session
  that holds the role. If it does not, fall back to fork-store Kafka records.

**Change 2: client library.** Replace `kafkajs` (unmaintained, measured to fetch nothing from
Kafka 4.x, no SASL/TLS in the old fork) with `@platformatic/kafka`.
- It is already an upstream dependency, so the fork adds no new one.
- Build a **separate** client instance in `src/storagebase/resources/providers/messaging/kafka.ts`.
  Upstream's client is restricted to `KAFKA_READ_APIS`, so do not reuse upstream's instance.
  Reuse its connection-option mapping (brokers, TLS, SASL PLAIN/SCRAM) by import if it is
  exported; otherwise mirror it.
- **Verify** that `@platformatic/kafka` exposes the needed admin APIs: `createTopics`,
  `createPartitions`, `incrementalAlterConfigs`, `deleteTopics`, `deleteGroups`,
  `alterConsumerGroupOffsets`/`OffsetCommit`, produce. If one is missing, keep `kafkajs` only for
  that call and record why.

**Change 3: kafka-ui parity backlog.** Each is a fork-only addition with no seams:
- SASL (PLAIN/SCRAM/OAUTHBEARER) and TLS
- Schema Registry (Avro/Protobuf/JSON decode in message view, subjects list)
- live tail
- Kafka Connect
- ACL listing
- log-dir sizes

Order these by owner priority. They are not part of the port.

**Upstream overlap note.** RabbitMQ and S3 are upstream read-only DB types too. If the fork keeps
its write-capable versions (D2), apply the same "upstream connection record + fork workbench"
pattern.

### 5.5 Redis Sentinel

The feature belongs inside `redis.ts`, which is a hot upstream file (27 commits / 60 days).

1. **First: open an upstream PR** that adds Sentinel to upstream's redis provider: fields,
   connection form, seed, docs §4.4, tests. Base it on the old fork's commits (`redis.ts`
   +92/−5 with `parseSentinelNodes`, `sentinelRetryStrategy`, `enableTLSForSentinelMode`, the
   `end` → `setConnected(false)` handler) and on `docs/providers/redis.md` §4.4. Follow
   upstream's triad rule. Once it merges, the fork carries nothing.
2. **Until then, the minimal interim** is seam S4 only.
   - The Sentinel settings travel in a field upstream already carries end to end, so no new
     connection fields are needed.
   - The candidate is a connection string `redis-sentinel://[:password@]host1:26379,host2:26379/<db>?name=<master>&sentinelPassword=…`.
     **Verify** first whether upstream passes the raw `connectionString` through to
     `RedisProvider`, or only parses it into host, port and password in the form
     (`redis-connection-string.ts` claims only `redis://` and `rediss://`). That decides the
     path:

   | If upstream… | Then |
   |---|---|
   | passes the raw string through | S4 alone is enough: `storagebaseSentinelOptions(config)` parses the scheme and returns `{ sentinels, name, sentinelPassword, sentinelRetryStrategy, enableTLSForSentinelMode, sentinelTLS }`, or `{}`. The connection is defined in a **seed** (seeds accept the string and `${vault:…}`), so no form change is needed. |
   | only parses it into fields | Fall back to the old fork's multi-file set (about 12 upstream files). Do this only with the owner's approval, and record each file in `SEAMS.md`. |

3. Port the integration tests to `tests/storagebase/integration/redis-sentinel.test.ts`, with a
   Sentinel fixture in `deploy/storagebase/compose.yml`.

### 5.6 Section rail and navigation

- Port `SectionShell`, `SectionRail`, `ResourceSectionPage`, `SectionConnectionList`,
  `SectionHeader` and their hooks into `src/components/storagebase/sections/`.
- Pages go in `src/app/(storagebase)/{storage,messaging,vaults}/page.tsx`.
- The rail's admin-only entries (Audit, Access, Vault exclusions) link to `/sb-admin/*`, so no
  upstream header or admin-section edits are needed.
- S1 is the only seam. Keep the old `[&>*]:h-full!` override inside the fork shell. **Verify** it
  still fits `Studio`'s root at the start ref; upstream wraps `Studio` in
  `WorkspaceOwnerGate` now.

---

## 6. Identity and access

**Sign-in.** Use upstream OIDC against Entra (`docs/OIDC.md`): `OIDC_ISSUER`, client id and
secret, `OIDC_ROLE_CLAIM=roles`, `OIDC_ADMIN_ROLES`, `OIDC_ROLE_PREFIX`, and allowed email
domains. Local break-glass login stays available upstream (**verify** how to restrict it; the old
fork had `STORAGEBASE_LOCAL_LOGIN`). Drop `src/lib/entra/**` and every edit to `auth.ts` and the
login files.

**Database connections**
- Use upstream seeds with `roles:` matched against Entra app roles.
- Use `readOnly: true` for read grants, ideally backed by a read-only DB user.
- Credentials via `${vault:…}` or env.
- This drops the fork's `assertManagedStatement` / `requireManagedPermission` edits in 5 DB
  routes.

**Resource connections.** Use the fork seed (5.1) with `roles:`. The permission level per role
(read / write / admin) needs a small fork-only mapping, e.g. a seed field
`permissions: { "<app-role>": "write" }`. Resource routes enforce it via the ported
`resource-permissions` route table, where anything unlisted needs admin.

**Admin-managed groups and bindings (old `/admin/access`).** Keep these only if D3 says so. They
stay fork-only at `/sb-admin/access` on the fork store and apply only to resource connections.
For databases, upstream's model is seeds, or **governance mode**. A possible later step is
investigating whether the fork's access admin can act as the governance control plane, which
would need no seam at all. This is not part of the port.

---

## 7. Guardrails and automation (build these first, phase 0)

**`scripts/storagebase/seam-check.mjs`**, run in CI and before every push:
1. `git diff --name-only <upstream-base>...HEAD`, filtered to paths that exist in the upstream
   base.
2. Every such path must appear in `SEAMS.md`. Otherwise fail.
3. Per seam file, the diff must stay within the ledger's line budget (default 3 added, 0
   removed). Otherwise fail.
4. It prints the seam table with current upstream churn.

`<upstream-base>` is the merge-base with the tracked upstream tag.

**`.github/workflows/storagebase-upstream-sync.yml`**, on schedule (weekly) and on demand:
1. Fetch upstream tags and pick the newest bare-semver tag.
2. Merge it into `sync/upstream-<tag>`. Never rebase.
3. Regenerate `bun.lock` (take upstream's, then `bun install`).
4. Run seam-check plus the full gate.
5. Open a PR. On a conflict, open the PR with the conflicted files listed (they must all be
   ledger seams).

**`.github/workflows/storagebase-ci.yml`** runs the upstream gate unchanged, plus fork tests and
100% coverage on `src/storagebase/**`. The upstream gate is `bun run format && bun run lint &&
bun run typecheck && bun run knip && bun run test && bun run build`; take the exact list from
upstream `CLAUDE.md` at the start ref.

**`.github/workflows/storagebase-image.yml`** builds `deploy/storagebase/Dockerfile.storagebase`.
Leave upstream's workflows untouched. If they fail or publish in the fork, disable them through
GitHub repo settings (Actions → disable per workflow), not by editing the files.

**`STORAGEBASE.md`** holds the fork rules (P1–P9, ledger pointer). **`CLAUDE.md`** is upstream's
file; do not edit it. Fork agents read `STORAGEBASE.md`. If an anchor line in `CLAUDE.md` is
unavoidable, it is a seam with a ledger row.

---

## 8. Execution plan for the porting agent

Each phase is a branch and a PR into the fork's `main`, gate green, seam-check green.

| Phase | Content | Seams |
|---|---|---|
| 0 | Create the fork at upstream tag `1.3.0` (or newest). Add the skeleton dirs, `STORAGEBASE.md`, `SEAMS.md`, `docs/storagebase/UPSTREAM_SYNC.md`, seam-check, the three workflows, `packages/storagebase-deps`, `Dockerfile.storagebase`, Helm values overlay. | S5, S6, S7 |
| 1 | Fork store (port `fork-store`, own tables, sqlite + postgres) and audit (S2, S3, masker, durable sink, `/sb-admin/audit`, redaction tests). | S2, S3 |
| 2 | Resource spine (fork store-backed, resource seed file, routes `/api/sb/*`, section rail + pages). | S1 |
| 3 | Azure Blob + AKV (with workload identity), vault workbench, exclusions if D3. | – |
| 4 | Kafka workbench on upstream `kafka` connection records and `@platformatic/kafka`. | – |
| 5 | Redis Sentinel: upstream PR first; interim S4 per 5.5. | S4 |
| 6 | Remaining providers per D2; social-link stubs per D5; AKV secret references per D4 (upstream PR first). | S8, S9 |
| 7 | Dry-run sync: merge the next upstream tag through the sync workflow and record the result in `UPSTREAM_SYNC.md`. **Acceptance:** zero conflicts outside ledger seams. | – |

**Porting source.** Read the old code from the old repo's git refs
(`git show 0c2bda12:<path>` in `storagebase/storagebase-studio`). Do not copy upstream-territory
diffs from the old fork; re-express each one through the seams above. The old fork's tests are the
behavioural spec: port them into `tests/storagebase/` and keep them green.

**Old fork documentation errors** (do not carry them over):
- `STORAGEBASE.md`, `docs/UPSTREAM_SYNC.md` and the handoff name a `rename-patch.sh` that does
  not exist; the real script is `scripts/rename-fork.mjs`. Under P6 neither is needed.
- No CI job ran the rename check.
- `STORAGEBASE_HANDOFF.md` §10 describes resource tabs in `ConnectionModal` / `Sidebar` /
  `Studio` that were later removed.

---

## 9. Decisions for the owner (defaults in bold)

| # | Question | Options |
|---|---|---|
| D1 | Where does the new fork live? A GitHub org can hold only one fork per upstream network. | (a) **re-use `storagebase/storagebase-studio`: archive the old `main` as `legacy/0.16-main`, reset `main` to the new base** (keeps the fork link, so upstream PRs from it are easy); (b) a new repo in another org. |
| D2 | Which non-mandatory resource types to port | **Azure Blob, AKV and Kafka are mandatory. Port HashiCorp Vault/OpenBao (cheap, fork-only); defer S3, RabbitMQ, SQS, AWS KMS and AWS Secrets Manager until there is a user, since upstream has read-only S3 and RabbitMQ.** |
| D3 | Admin-managed access model (groups, bindings, `/admin/access`) vs config-only seeds with `roles:` | **Config-only first (section 6); port the admin UI later as fork-only for resources if needed.** |
| D4 | Must AKV feed *connection credentials* (`${akv:…}` in seeds), or is the AKV workbench enough? | **Workbench only. Credential references go through an upstream "pluggable secret resolver" PR; no S9 seam until then.** |
| D5 | Remove social and star links? | **Yes via leaf stubs (S8, 2 quiet files)**; or accept upstream's links (zero seams). |
| D6 | Branding depth | **Visible name via fork-owned build and Helm overlay only; no in-tree rename (P6).** |
