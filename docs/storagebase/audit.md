# The StorageBase audit trail

The fork's own audit trail: what it records, where the records go, how they are masked, and how an
administrator reads them. This mirrors the code exactly — `src/storagebase/audit/**`,
`src/storagebase/store/**`, the two seams in `src/lib/query-events/sink.ts` (S2) and
`src/lib/audit.ts` (S3), and the page at `/sb-admin/audit`.

## The event schema: `storagebase.audit.v1`

Every fork audit event is one `StoragebaseAuditEvent` (`src/storagebase/audit/types.ts`), written to
two destinations with one identity: the durable row (`storagebase_audit_events`) and one stdout JSON
line stamped `schema: "storagebase.audit.v1"`. The fork never extends an upstream closed union (P3):
`type` composes upstream's `AuditEventType` plus the fork's own `resource_operation`, and `reason`
is a fork vocabulary of codes (upstream `AuditReason` names, `resource_*` codes, driver SQLSTATEs) —
never free text.

| Field | Meaning | Filled by |
| --- | --- | --- |
| `id`, `timestamp` | The event's identity. Minted at record time; an S3 event keeps the upstream event's own, so the fork line joins the upstream line by id | sink |
| `type` | `query_execution`, `resource_operation`, or any upstream `AuditEventType` | all |
| `action` | `executed` / `explained` / `failed` / `cancelled` / `refused` for queries; the resource vocabulary (`blob.download`, `kafka.messages.read`, …) for resource actions; the upstream verb for S3 events | all |
| `target` | The query event's source surface (`editor`, `transaction`, …); a resource action's address (bucket/key, vault path, topic); the upstream event's route | all |
| `result` | `success` or `failure` | all |
| `user`, `role` | The caller's username (or role when the session carries no name) and the session's role | all |
| `details`, `duration`, `reason`, `correlationId`, `connectionName`, `container`, `engineUser`, `bucket`, `passkey` | The upstream base fields, copied field-for-field from S3 events; `duration` and `correlationId` also set by the query and resource paths | S3 / queries / resource |
| `ip` | The address the request's route resolved (S2's `clientIp`), or the fork route's `clientAddress()` reading. A hint, never an identity | queries / resource / S3 |
| `forwardedFor`, `userAgent` | The raw `X-Forwarded-For` chain and the user agent, recorded only while `TRUST_PROXY_HEADERS` is on; never from the S2 tap, which has no request object | fork routes |
| `connectionId`, `engine` | The connection the action ran on, and its engine type | queries / resource |
| `host`, `database` | The connection's host and database. **Unfilled today**: the S2 input's connection names neither, and nothing else reaches them | — |
| `statementKind` | `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `DDL` / `OTHER`, read through the query limiter's own classifier (or the route's own statement type when it knows better) | queries |
| `statement`, `statementTruncated` | The MASKED statement (see below), and whether it was cut to its 4096-character bound | queries |
| `rowsReturned`, `rowsAffected` | The count the engine reported: a write's count is what it changed, a read's is what it returned; an EXPLAIN never counts as a write | queries |
| `error` | The driver's sentence with its quoted values masked | queries |
| `queryId` | The client's own cancellation id, a label. **Unfilled today**: the S2 input carries none | — |
| `counts` | Small numeric facts about a resource action (items listed, bytes read), numbers and booleans only, at most 8, identifier-shaped keys | resource |
| `authProvider`, `subject`, `appRoles` | The sign-in identity vocabulary | — |
| `permission`, `grantedBy`, `accessGroups` | The grant a managed-connection action ran under | — |

The last six fields are part of the fork vocabulary but unfilled in this phase: the access model
they describe was dropped with the re-fork, and phase 2's resource routes and any later identity
work emit against them.

## The two seams

- **S2 — `src/lib/query-events/sink.ts`, `recordQueryEvent`'s first line.** Every executed (or
  refused) unit every statement-executing route passes through — governance or not, which is the
  point: the old fork audited per-route and missed `transaction`, `maintenance`, `profile` and
  `keys/scan`; this seam misses nothing. The fork receives the full `QueryEventInput`
  (verified at this ref: principal subject/username/role, connection id/name/engine/access level,
  statement, status, statement type, start, explain, row count, error code and text, correlation id,
  transaction id and outcome, client address) and builds its event in
  `src/storagebase/audit/query-event.ts`.
- **S3 — `src/lib/audit.ts`, `emitAuditEvent`'s last statement.** Every upstream audit event —
  sign-ins, sign-outs, role denials, rate limits, agent and MCP operations, object edits — reaches
  the fork trail converted field-for-field (`src/storagebase/audit/upstream.ts`), keeping the
  upstream event's id and timestamp so the two stdout lines join.

Both seams call `src/storagebase/core/seams.ts`, which is tiny and dependency-free: it lazily loads
`src/storagebase/audit/sink` with a fire-and-forget dynamic import on the first tap, and a sink that
cannot load, or a record that cannot run, is swallowed — **a failing audit tap can never fail a query
or a request** (the old fork's invariant, held by tests in `tests/storagebase/unit/core/`).

Fork resource routes (phase 2) record directly through `src/storagebase/audit/resource.ts`: a write
is a decision event and an outcome event joined by one correlation id; a read is one event with
counts. The reason vocabulary is closed (`resource_unsupported`, `resource_not_found`,
`resource_conflict`, `resource_invalid_request`, `resource_failed`), mapped from the fork's typed
errors in `src/storagebase/resources/errors.ts`.

## Where the records go

The sink (`src/storagebase/audit/sink.ts`) mirrors the discipline of upstream's own query-event sink:

- a bounded queue (10 000; one more is dropped, counted, and logged once per spell — its line has
  already been printed and it stays in the ring),
- a flush every second, or at once at 500 events,
- **one stdout JSON line per event** at the first flush that reaches it (printed exactly once,
  whatever the store does), and
- **the durable row** through the store's `appendAuditEvent` — idempotent, so a retry after a
  partial write adds nothing; a failed write keeps the batch and backs off (1 s doubling to 30 s),
- a shutdown hook (`storagebase-audit-flush`) that drains what is queued without waiting out the
  backoff, for at most 4 s.

The flush timer is scheduled with the timers pinned at the seams module's load, not with
`globalThis.setTimeout`: a fake clock installed afterwards (upstream's own sink test installs one,
to prove it leaves no timer behind) must not capture the fork's flush. In production the pinned pair
is the process's own timers, so nothing changes.

A third copy lives in memory: the sink's ring of the newest 1000 fork events. When there is no
durable store to answer the admin page, the page is served from the fork ring **plus** upstream's
own ring buffer (converted), which are disjoint by construction — the fork ring holds query and
resource events upstream never buffers, and upstream's ring holds the S3 events, which the fork
deliberately does not re-ring.

## The store

The durable trail lives in the fork's own tables — `storagebase_audit_events` (the audit trail) and
`storagebase_records` (the generic kind/id/value records API; phase 2 stores the fork's resource
connections there) — beside the upstream storage layer, driven by whichever server storage
`STORAGE_PROVIDER` names (`sqlite` or `postgres`), through the same env the storage layer reads
(`STORAGE_SQLITE_PATH`, `STORAGE_POSTGRES_URL`). There is no `STORAGEBASE_STORE_*` env (P5). With
`local` storage the store is null and the trail is the ring plus the stdout line.

The store is one per process, held on globalThis; a failed open is retried, not memoized. The SQL
is written once for both engines (TEXT columns, `?` placeholders the PostgreSQL driver rewrites to
`$n`, ISO-8601 text timestamps that order correctly in both).

### Retention: `STORAGEBASE_AUDIT_RETENTION_DAYS`

Whole days; `0` keeps everything; anything else is the default of **365** (capped at 36500). The
prune rides on an append, at most once per hour.

## Masking guarantees

- **The statement is masked, never raw** (`src/storagebase/audit/masker.ts`, ported from the old
  fork's `audit-sql.ts`): every literal — single/dollar/Oracle-quoted strings, numbers, comments —
  becomes `?`, read through the engine's own grammar. MongoDB documents keep their collection and
  operation and mask every value; a Redis command keeps its name and masks every argument, key
  included. Above 4096 characters the text is cut and `statementTruncated` says so.
- **The error text is masked the same way**: drivers echo the offending value back, so quoted runs,
  key-detail value lists and free-standing numbers are `?` before the text becomes a field.
- **`counts` cannot carry a value** by construction: numbers and booleans, identifier-shaped keys,
  at most 8.
- Every free-text field is swept once more at the sink (upstream's own `redactUriCredentials` rule)
  and bounded (254 characters; the masked statement 4096).

These are not just review claims: `tests/storagebase/security/query-audit-redaction.test.ts` drives
the real S2 seam and asserts, over the durable row **and** the stdout line, that no literal or
credential survives — with the store failing and the stdout failing in turn, proving the tap never
fails the query. `resource-audit-redaction.test.ts` does the same for the resource helpers' counts
and addresses. (The old fork's vault-audit-redaction suite is deferred with the vault routes it
drove — phase 2.)

## Reading the trail: `/sb-admin/audit`

The page (a server component at `src/app/(storagebase)/sb-admin/audit/page.tsx` rendering
`src/components/storagebase/admin/AuditPage.tsx`, a port of the old fork's AuditTab extensions)
self-guards admin: `src/proxy.ts` JWT-protects `/sb-admin` but role-gates only `/admin`, so the page
reads the session server-side through upstream's `getSession()` and answers the admin-required
refusal to anything else — the same refusal its API answers.

Its route, `POST /api/sb/admin/audit` (`src/app/api/sb/admin/audit/route.ts`), calls upstream's
`guardRoute` (the census shape), records a role denial through upstream's `auditRoleDenial`, and
answers:

- filters — `type`, `action`, `user`, `ip`, `engine`, `result`, `text` (case-insensitive substrings;
  `ip` also matches the forwarded chain), `from`/`to` (ISO-8601 bounds), cursor paging with
  `limit` (clamped to 1..1000, default 100),
- `{ events, nextCursor, source, total }` — `source` says whether the durable store answered or the
  buffered rings did, so the page can say whether the trail survives restarts,
- `export: true` — every matching row as one JSON document, paged server-side, bounded at 50 000.

The errors are the fork's own codes, built directly (never through upstream's `ApiErrorCode` table —
P3): `SB_AUDIT_INVALID_BODY` (400), `SB_AUDIT_INVALID_CURSOR` (400), `SB_AUDIT_READ_FAILED` (500).

## Invariants held by tests

1. No secret value, credential or unmasked literal reaches any audit destination — asserted over
   the durable row and the stdout line (`tests/storagebase/security/`).
2. Every tap is fire-and-forget and isolated: a sink that cannot load, a stdout that cannot write, a
   store that cannot open — none of them fails a query or a request.
3. The sink never holds the process open on its own, and the shutdown flush is bounded.
4. The upstream route census holds: the route calls `guardRoute` first, and `/sb-admin/*` pages
   enforce the admin role themselves.
