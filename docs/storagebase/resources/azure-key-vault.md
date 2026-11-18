# Azure Key Vault provider (`azure-key-vault`)

The Azure Key Vault workbench: secrets, keys and certificates over
`@azure/keyvault-secrets`, `@azure/keyvault-keys` and
`@azure/keyvault-certificates`, one Entra ID credential shared by all three.
The SDKs sit in the fork's deps workspace (`packages/storagebase-deps`, P8),
are declared structurally in the provider (root tooling cannot resolve
type-only imports from there), load lazily through `loadResourceSdk`, and are
externalized server-side through `STORAGEBASE_SERVER_EXTERNALS` (seam S6) and
staged into the standalone Docker payload by
`scripts/storagebase/stage-resource-sdks.mjs`.

## Connection

The vault as `endpoint` (any host the SDK speaks to — other clouds, a private
endpoint), or `vaultName` for `https://<vaultName>.vault.azure.net`. No
shared-key spelling exists for Key Vault (unlike Blob storage), so none is
offered.

`clientSecret` is a **sealed secret field** (`SECRET_RESOURCE_FIELDS` in
`src/storagebase/resources/ui-config.ts`): it is sealed before a record
reaches the fork store, never served back to the browser, and resolved from
`${env:…}` / `${vault:…}` references when a seeded connection names it. The
browser's row carries only the "has credential" marker.

### Not a credential source (decision D4)

This workbench is where AKV values are read and written; it is **not** a
credential resolver for other connections. A seed connection cannot name
`${akv:…}` the way it names `${vault:…}` — upstream's credential resolver is
a hard-coded prefix switch (`SEAMS.md` S9 is reserved, not applied). When AKV
must feed connection credentials, the path is upstream's pluggable
secret-resolver PR first (P7), and only then an `${akv:…}` seam.

### Auth modes

`authMode` selects the credential; without it the fields decide:

| mode | credential | requires | notes |
|---|---|---|---|
| `client-secret` | `ClientSecretCredential` | `tenantId` + `clientId` + `clientSecret` | **the default when a `clientSecret` is present** (the legacy behaviour) |
| `workload-identity` | `WorkloadIdentityCredential` | nothing | **the default when no client secret is present** — the in-cluster default this fork adds. `tenantId`/`clientId` ride the credential when the record spells them; otherwise the pod's `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_FEDERATED_TOKEN_FILE` drive it. An AKS deployment with workload identity federation needs no credential in the connection at all. |
| `managed-identity` | `ManagedIdentityCredential` | nothing | opted into explicitly. `clientId` names a user-assigned identity; without it the system-assigned identity is used. |

An explicit `authMode` wins over what the fields would imply (a record
carrying a `clientSecret` but `authMode: "workload-identity"` authenticates
as workload identity and leaves the secret unused). An unknown `authMode` is
a `SB_RESOURCE_CONFIG_ERROR` at construction, never a guess. Client-secret
auth without the full triple is likewise a config error.

## Workbench

Vault connections open the **vault workbench** full-page on the Vaults page
(`opensWorkbench()`), like Kafka. Tabs **Secrets / Keys / Certificates** (the
`vault.secrets`, `vault.keys`, `vault.certificates` flags), each a list +
detail split with a client-side filter (name or tag), and a **Deleted items**
view (`vault.soft-delete`). A read-only connection (a seeded one granted
`read`) has every write flag withheld before the tabs see them — Reveal is a
read and stays.

- **Secrets** — list: name, enabled, content type, updated, expires
  ("Never"), tags. Detail: every property (enabled, content type, created,
  updated, expires, not-before, tags, version id, recovery level) and the
  version history. The value is masked with **no characters shown**; Reveal
  is the only call that reads it (`/api/sb/vault/secret/reveal`,
  `Cache-Control: no-store`), Hide drops it from state, Copy exists only
  while revealed. Edit opens an **empty** form: a typed value adds a version
  (with content type / tags / expiry / enabled); an empty value updates the
  current version's properties in place (`updateSecretProperties`) without
  reading or re-sending its value.
- **Keys** — list: type (RSA/EC), size or curve, enabled, expires, tags
  (the list API carries no key type: the first 100 rows are enriched by a
  per-key `getKey`, best effort, 4 in flight). Detail: permitted operations
  and versions. Create RSA 2048/3072/4096 or EC P-256/P-384/P-521.
- **Certificates** — list: subject, issuer (from the policy, enriched like
  keys), thumbprint, not-before / expires, enabled. Import PEM/CER/CRT
  (`application/x-pem-file`) or PFX/P12 (`application/x-pkcs12`) with an
  optional password; files are bounded at 1 MiB (checked in the browser and
  again by the route).
- **Delete is soft** for all three (begin + poll, nothing else). Recover and
  Purge live on the Deleted view; Purge asks for the typed name
  ("permanently deletes … cannot be undone") and the route requires
  `confirm` to repeat it before the provider is asked.

### The value-reading invariant

Opening a secret never reads its value: the detail is built from
`listPropertiesOfSecretVersions` (the current version is the newest), not
`getSecret` — which would also land in the vault's own access log as a
secret read. Exactly two routes answer a value, and both carry
`Cache-Control: no-store`:

- `/api/sb/vault/secret/reveal` — the workbench's Reveal, audited as
  `vault.secret.reveal`;
- `/api/sb/vault/secret/read` — the generic secret surface's read (the
  legacy `/api/resources/secret/read`), audited decision + outcome like a
  write, the deliberate exception to "reads emit one event": secret
  material access is what operators filter the trail for.

Every other route answers metadata, versions and counts only
(`tests/storagebase/api/vault/vault-routes.test.ts` pins this mechanically:
each non-value route's response body is scanned for the fake vault's
distinctive values).

## Routes

All POST, all through `handleResourceRequest` (guard → parse → resolve), all
audited through the fork trail with counts only — values, key material,
certificate contents and passwords never enter an event.

| route | action | seeded grant |
|---|---|---|
| `/api/sb/vault/objects` | `vault.list` | read |
| `/api/sb/vault/object` | `vault.describe` | read |
| `/api/sb/vault/deleted` | `vault.list-deleted` | read |
| `/api/sb/vault/secret/reveal` | `vault.secret.reveal` | read |
| `/api/sb/vault/secret/read` | `secret.read` | read |
| `/api/sb/vault/secret/save` | `vault.secret.save` | write |
| `/api/sb/vault/secret/write` | `secret.write` | write |
| `/api/sb/vault/secret/delete` | `secret.delete` | write |
| `/api/sb/vault/key/create` | `vault.key.create` | write |
| `/api/sb/vault/certificate/import` | `vault.certificate.import` | write |
| `/api/sb/vault/object/delete` | `vault.delete` | write |
| `/api/sb/vault/deleted/recover` | `vault.recover` | write |
| `/api/sb/vault/deleted/purge` | `vault.purge` | **admin** |

The seeded-grant column is the row each route needs in
`RESOURCE_ROUTE_PERMISSIONS` (`src/storagebase/resources/permissions.ts`);
a route missing from that table fails closed to `admin`. Purge is the
workbench's one irreversible action and sits on the `admin` level, on top
of the `confirm`-by-name check the route itself enforces.

The vault family's shared half lives in
`src/storagebase/resources/providers/vaults/`:
`resource-vault.ts` (the generic secret surface's capability gate) and
`resource-vault-workbench.ts` (the workbench's capability gate, body
validators and audit wrappers). A vault provider without a workbench API of
its own resolves to `BasicVaultWorkbench` over `VaultOperations` — the
surface HashiCorp Vault / OpenBao use when they land (phase 6).

The old fork's **vault exclusion rules** (and the
`ExcludingVaultWorkbench` wrapper, the admin API and the workbench's
notice) are not ported: decision D3 dropped the admin access model they
belonged to. What the provider lists is what the routes answer.

## Error mapping

Missing objects answer 404 with code `SecretNotFound` / `KeyNotFound` /
`CertificateNotFound` (or any 404); 409 maps to `SB_RESOURCE_CONFLICT`
(being deleted, purge protection), 400 to
`SB_RESOURCE_INVALID_REQUEST`, anything else to
`SB_RESOURCE_CONNECTION_ERROR` (502).

## Testing

`tests/storagebase/integration/azure-key-vault-provider.test.ts` doubles the
three SDKs and `@azure/identity` with `mock.module` — there is NO Key Vault
emulator (the documented limitation), so the tests are mock-anchored to the
SDKs' documented contracts. The fake counts every `getSecret`, so "opening a
secret never reads its value" is asserted, not assumed. The identity doubles
record their constructor arguments, which is how the auth-mode matrix above
is pinned. Routes: `tests/storagebase/api/vault/` (workbench + generic
secret surface, the value-reading invariant, purge confirmation); the
generic workbench fallback: `tests/storagebase/unit/vault/basic-workbench.test.ts`;
UI: `tests/storagebase/components/vault/`.

## Known limitations

- No managed HSM, no certificate creation / issuer management / policy
  editing (import only), no key rotation policy, no key operations
  (encrypt/sign) from the UI.
- Listings stop at 1000 objects and version lists at 100 (flagged); key
  and certificate enrichment covers the first 100 rows.
- Editing properties cannot clear an expiry (Key Vault's PATCH ignores an
  absent field); save a new value without one instead.
- Tags on an edit are re-entered whole: the form never pre-fills.
- RBAC vs access-policy differences surface as the service's own errors.
