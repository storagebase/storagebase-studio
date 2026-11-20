# Fork resource spine (phase 2a)

The StorageBase resource layer: blob storage, messaging systems and key vaults beside the
database studio, all under fork-owned paths (STORAGEBASE.md P1 — `src/storagebase/resources/**`,
`src/app/api/sb/resources/**`, `src/components/storagebase/resources/**`). This page is the
spine's contract: the type union, the permission levels, the route surface with exact request
and response shapes, the connection storage + sealing model, the seed file format and the fork
error codes. The per-type pages live beside it: [`azure-blob.md`](azure-blob.md),
[`azure-key-vault.md`](azure-key-vault.md), [`kafka.md`](kafka.md),
[`hashicorp-vault.md`](hashicorp-vault.md) and [`openbao.md`](openbao.md) — code, doc and tests
stay 1:1 per type-id (the fork triad rule).

## The type union (the only list)

`ResourceType` in [`src/storagebase/resources/types.ts`](../../../src/storagebase/resources/types.ts):

| type-id | family (`ResourceCategory`) | provider module |
|---|---|---|
| `azure-blob` | `blob` | `providers/blob/azure-blob.ts` (phase 3) |
| `kafka` | `messaging` | `providers/messaging/kafka.ts` (phase 4) |
| `azure-key-vault` | `vault` | `providers/vaults/azure-key-vault.ts` (phase 3) |
| `hashicorp-vault` | `vault` | `providers/vaults/vault.ts` (one module, two ids) |
| `openbao` | `vault` | shares the HashiCorp Vault module |

S3, RabbitMQ, SQS, AWS KMS and AWS Secrets Manager are **deferred** (decision D2): each adds a
`RESOURCE_UI_CONFIG` row and one registry import line the day it lands. Nothing in the spine
branches on a type-id outside a provider module, and the fork never adds a `DatabaseType`.

A type is *selectable* in the UI only when its provider module is registered
(`selectableResourceTypes` in `ui-config.ts`, fed by the registry; families self-register
through `providers/index.ts`, imported once by `handle-request.ts`).

## Permission levels

The fork's seeded connections carry one of three levels (config-only, decision D3 — the legacy
access model's groups and bindings are gone):

- **`read`** — list, browse, peek, reveal (still audited), download, inspect, test.
- **`write`** — create, update, delete an object, publish, produce, upload, soft-delete, recover.
- **`admin`** — the irreversible ones (purge, delete a topic or consumer group, reset offsets).

`RESOURCE_ROUTE_PERMISSIONS` in `permissions.ts` maps every route name to the level it needs;
**a route missing from the table needs `admin`** (fail closed). Stored (user-created)
connections carry no level — they are the deployment's own, full access. Route→level pairs live
in one table; `tests/storagebase/unit/resources/permissions.test.ts` keeps it and the route
tree naming exactly the same routes.

## Route surface

Every route is `POST`, starts with `guardRoute({ route, bucket: "query", request })` (the
upstream census shape — see `tests/security/route-auth.test.ts`), and answers fork-local
`SB_*` error codes. Admin-only routes additionally enforce
`guard.session.role !== "admin" → adminRequiredResponse()` after the guard.

A connection is named in the body either way the caller holds it:

- `{ "connectionId": "res_<minted>" }` — a stored connection (fork store, sealed).
- `{ "connectionId": "seed:<id>" }` — a preconfigured connection (fork seed file, roles-matched).
- `{ "connection": { …full record… } }` — the pre-save candidate the connection form is still
  editing (its secret travels once, for the probe, and is stored sealed only on save). An
  inline id may not claim the `seed:` prefix.

`connectionId` wins when a body carries both.

### `POST /api/sb/resources/connections`

Body `{ "action": "list" }` (any session):

```json
{
  "connections": [
    {
      "id": "res_a1b2…", "name": "Prod Vault", "type": "hashicorp-vault",
      "createdAt": "2026-11-18T…", "endpoint": "https://vault:8200", "namespace": "ops",
      "hasCredential": true
    },
    {
      "id": "seed:prod-vault", "name": "Prod Vault", "type": "azure-key-vault",
      "createdAt": "2026-11-18T…", "vaultName": "prod-kv", "hasCredential": true,
      "seeded": true, "permission": "write"
    }
  ],
  "storeAvailable": true
}
```

Rows are merged (store + role-matched seed), sorted by name. A row NEVER carries a secret
value: `clientSecret`, `token`, `secretAccessKey`, `sessionToken`, `accountKey`,
`connectionString`, `password` are sealed at rest and answered as `hasCredential` (boolean)
instead. `seeded: true` rows are read-only from the UI (no edit, no delete); the UI also
withholds write controls when `permission` is below the route's level (`readOnly` is exactly
`seeded && permission === "read"`). `storeAvailable: false` means STORAGE_PROVIDER=local: the
stored half cannot exist and create/update/delete answer 503.

Body `{ "action": "create", "connection": { name, type, …fields } }` (admin only) — the server
mints the `res_…` id, seals the secret fields and answers
`{ "connection": <row> }`. The caller's id, if any, is ignored; `sshTunnel` is refused with its
own sentence until a family uses it.

### `POST /api/sb/resources/connections/[id]`

Admin only, both actions:

- `{ "action": "update", "connection": { name, type, …fields } }` — replaces the non-secret
  fields and re-seals the secret ones given. A secret field left **blank or absent keeps the
  stored envelope** (the edit form never echoes a secret back). Removing a credential means
  re-creating the connection. Answers `{ "connection": <row> }`.
- `{ "action": "delete" }` — removes the record and closes its cached provider. A missing id is
  not an error (`{ "deleted": true }`).

A `seed:` id answers 403 `SB_RESOURCE_SEED_READONLY` on both actions before any store access.

### `POST /api/sb/resources/{tree,meta,test,health}` (any session)

All four take a body naming the connection (either form):

- `tree` — `{ …, "parent"?: "<node id>" }` → `{ "nodes": ResourceNode[], "truncated": boolean }`.
  One bounded level; `truncated` is the provider's honest sentence about its own bound.
- `meta` — `{ category, capabilities, labels }` from the unconnected provider (the parallel of
  `/api/db/provider-meta`).
- `test` — connect, read health, disconnect (nothing cached):
  `{ "success": boolean, "degraded": boolean, "message": string, "latencyMs"?: number }`.
  Connected-but-unhealthy is a degraded SUCCESS (browse may still work).
- `health` — `{ "status": "healthy" | "degraded" | "error", "message"?, "latencyMs"? }` for the
  sidebar pulse.

Every action is on the fork audit trail (`storagebase.audit.v1`, counts only, never values):
reads leave one `resource_operation` outcome event; the connection CRUD leaves the
decision+outcome pair joined by a correlation id.

## Connection storage and sealing

Stored connections live in the fork store (`src/storagebase/store`), as records of kind
**`"resource-connection"`**, keyed by the id the server minted. The record is a
`ResourceConnection` whose secret fields are `v1:<iv>:<body+tag>` AES-GCM envelopes — sealed by
**importing** upstream's `encryptSecret`/`readSecret` (`@/lib/storage/encryption`, P4), never
by editing it:

- **create** seals before `putRecord` — a leaked store file is useless on its own;
- **resolve** (for a request) opens the envelopes server-side; an envelope this key cannot open
  (a rotated key) is a 400 naming the field to re-enter, never a silent empty credential;
- **the browser** only ever sees the row above — non-secret fields plus `hasCredential`.

With `STORAGE_PROVIDER=local` there is no store: CRUD answers 503 `SB_STORE_UNAVAILABLE`
("rather than pretending"), while list keeps serving the seed rows and the seeded connections
keep working (the seed file needs no store).

### The definer's permission grant

Every stored record carries a `permission` the **defining operator chose** in the connection
form (`read` | `write` | `admin`; least privilege `read` when omitted, and a record written
before the grant existed answers `read` rather than an implicit full grant). The grant bounds
everyone who uses the connection, exactly like a seeded entry's role-derived grant:

- `read` withholds every write affordance and refuses write/admin routes with a 403
  (`SB_RESOURCE_ACCESS_DENIED`, audited);
- `write` allows non-destructive writes, `admin` the irreversible ones (`purge`, `topic/delete`,
  …; admin routes still require an admin session).

The permission is checked **before** a stored record's sealed credentials are opened for use,
and it travels on the browser row (`permission`) so the UI withholds write controls. For Kafka
the same rule applies: a stored or seeded connection's grant caps the session's role, while an
upstream `kafka` seed (no fork grant) keeps the role-based split.

Create/update/delete are admin-only because the records are shared, deployment-wide — the
store has no per-user scoping. A `user` tests and uses connections (including their own
unsaved ones through the inline path) but does not change what everyone else can use.

## The seed file

`STORAGEBASE_RESOURCE_SEED_PATH` (default `/app/config/storagebase-resources.yaml`) points at
a YAML file in the same shape as upstream's seed config — one `connections:` list, entries
validated by a fork-owned zod schema (upstream's seed schemas are never extended, P3):

```yaml
connections:
  - id: prod-vault                 # lowercase alphanumeric with hyphens
    type: hashicorp-vault          # a fork ResourceType id
    name: "Production Vault"
    roles: ["*"]                   # upstream's roles: vocabulary
    permission: read              # optional; read | write | admin; default read
    group: "Vaults"
    environment: production
    fields:
      endpoint: "${VAULT_ADDR}"
      token: "${vault:secret/data/studio#token}"
      namespace: "ops"

  - id: payments-kv
    type: azure-key-vault
    name: "Payments Key Vault"
    roles: ["app:payments"]         # an OIDC claim role under OIDC_ROLE_PREFIX
    permission: write
    fields:
      vaultName: "payments-kv"
      tenantId: "11111111-1111-1111-1111-111111111111"
      clientId: "22222222-2222-2222-2222-222222222222"
      clientSecret: "${vault:secret/data/studio#akv-client-secret}"
```

- **`roles`** is matched against the session with upstream's own `seedRolesOf` and `rolesMatch`
  (imported): `*`, `admin`, `user`, plus OIDC claim roles under `OIDC_ROLE_PREFIX`. A
  non-matching entry is not listed and resolves as the same 404 an unknown id answers.
- **`fields`** keys must be resource connection field names (the `RESOURCE_CONNECTION_FIELD_NAMES`
  vocabulary); a typo refuses the file with the key named.
- **`${ENV}` references** resolve eagerly at load, by calling upstream's
  `resolveConnectionCredentials`. **`${vault:mount/data/path#key}`** references resolve only
  when a role-matched connection is opened, by calling upstream's `resolveVaultCredentials` —
  so listing connections never reads a secret. Upstream's resolvers iterate their own database
  field list, so each fork field value rides through them under a carrier key (`host`); the
  fork field name never crosses into upstream code.
- **`SEED_LITERAL_VALUES`** applies to this file as it does to upstream's: with it on, every
  value is read as written and no reference resolves.
- A broken **entry** is skipped with a warning naming its id; a broken **file** (unreadable,
  unparsable, invalid, or carrying a custom role the sign-in mode can never match) serves
  nothing and logs the path; a missing file is a zero-config install.

Seeded connections are READ-ONLY from the UI: no edit, no delete, only the file changes them.

## Fork error codes

Fork routes answer `{ "error": <sentence>, "code": "SB_…", "statusCode": <n> }`; the codes are
fork-local strings, never members of upstream's `ApiErrorCode` union (P3).

| code | status | means |
|---|---|---|
| `SB_RESOURCE_INVALID_REQUEST` | 400 | a body the route refused before any provider |
| `SB_RESOURCE_CONFIG_ERROR` | 400 | a record that cannot be a provider (or a sealed credential the key cannot open) |
| `SB_RESOURCE_NOT_FOUND` | 404 | the uniform miss: unknown id, ungranted seed, gone record |
| `SB_RESOURCE_PROVIDER_UNAVAILABLE` | 501 | the type-id has no provider module registered |
| `SB_RESOURCE_OPERATION_UNSUPPORTED` | 400 | the provider declares no such operation |
| `SB_RESOURCE_CONFLICT` | 409 | well-formed but the resource's state forbids it |
| `SB_RESOURCE_CONNECTION_ERROR` | 502 | the provider connected but the service refused |
| `SB_RESOURCE_ACCESS_DENIED` | 403 | a seeded connection below the route's level |
| `SB_RESOURCE_SEED_READONLY` | 403 | an edit/delete aimed at a seeded connection |
| `SB_STORE_UNAVAILABLE` | 503 | no fork store configured (STORAGE_PROVIDER=local) |

## Porting notes

- Ported from the legacy fork (`legacy/0.16-main:src/lib/resources/**` +
  `src/lib/api/resource-route.ts`) with the storage cut over to the fork store, the access
  model replaced by the seed file's roles + permission, and the legacy
  `RESOURCE_*` codes renamed `SB_RESOURCE_*`.
- Dropped with the access model: `vault-exclusions*`, the managed-connection store and its
  `managed:` namespace, and `user-connections` (server-held secrets are now the default for
  every connection, so the `user:` namespace and `savedSecrets` field are gone).
- The UI halves: `resource-icons.tsx` (the 5 marks), `viewer-registry.ts` (families register one
  viewer per type-id) and `route-refusal.ts` (a refusal body → a sentence) live under
  `src/components/storagebase/resources/` for the section pages.
