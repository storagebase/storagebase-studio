# Azure Key Vault provider (`azure-key-vault`)

## Connection

The vault as `endpoint`, or `vaultName` for
`https://<vaultName>.vault.azure.net`, with Entra ID (`tenantId` +
`clientId` + `clientSecret` via `ClientSecretCredential`). No shared-key
spelling exists for Key Vault (unlike Blob storage), so none is offered.
Three SDKs share the credential: `@azure/keyvault-secrets`,
`@azure/keyvault-keys` and `@azure/keyvault-certificates` (all
`serverExternalPackages`, staged by `scripts/stage-resource-sdks.mjs`).

Vault connections list in the sidebar's **Connections** list and open the
**vault workbench** in the main area (`opensWorkbench()`), like Kafka. The
generic tree (`/api/resources/tree`) and secret routes still answer for API
callers; no dialog viewer exists for vault types any more.

## Workbench

Tabs **Secrets / Keys / Certificates** (the `vault.secrets`, `vault.keys`,
`vault.certificates` flags), each a list + detail split with a client-side
filter (name or tag), and a **Deleted items** view (`vault.soft-delete`).

- **Secrets** — list: name, enabled, content type, updated, expires
  ("Never"), tags. Detail: every property (enabled, content type, created,
  updated, expires, not-before, tags, version id, recovery level) and the
  version history. The value is masked with **no characters shown**; Reveal
  is the only call that reads it (`/api/resources/vault/secret/reveal`,
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
  Purge live on the Deleted view; Purge asks for the typed name ("permanently
  deletes … cannot be undone") and the route requires `confirm` to repeat it.

Opening a secret never reads its value: the detail is built from
`listPropertiesOfSecretVersions` (the current version is the newest), not
`getSecret` — which would also land in the vault's own access log as a
secret read.

## Routes

`/api/resources/vault/{objects, object, deleted, secret/reveal,
secret/save, key/create, certificate/import, object/delete,
deleted/recover, deleted/purge}` — POST, `{ connection, type?, name?, ... }`.
Reads are audited with `auditedResourceRead` (one event, counts only);
writes with decision + outcome and the caller's request fields. Values, key
material, certificate contents and passwords never enter an event
(`tests/security/vault-audit-redaction.test.ts`).

## Exclusion rules (admin)

Per vault identity (`vaultIdentity`: type + normalized vault URL), a list of
`{ pattern, kind: exact|glob|regex, objectType: secret|key|certificate|any,
note }`, stored in the fork settings store (`getForkStore().setSetting`,
key `vault-exclusions:<type>:<address>`). Enforced server-side on every
vault route — workbench, legacy secret routes and the tree — for everyone,
admins included: excluded objects vanish from lists, version and deleted
lists, and any by-name call answers the same 404 a missing object gets.
Matching is case-insensitive; globs are a linear two-pointer match; regexes
are restricted at save AND load time (no backreferences or lookaround, no
repeated group containing a repetition or alternation, at most two unbounded
quantifiers, 256-character evaluation bound). Fail closed: an unreadable
store or an invalid stored row refuses the vault instead of showing it
unfiltered. With `STORAGE_PROVIDER=local` no store exists, so no rule can be
saved (409 with the reason).

Admin API: `GET/PUT /api/resources/admin/vault-exclusions?type=&address=`
(admin role, audited; a PUT records the before/after rule sets) and
`POST …/preview` (counts per type of what a draft would hide — never names).
The workbench shows the editor to admins (Exclusions button).

## Legacy operations

`tree`, `secret.read` (value + version), `secret.write` (setSecret),
`secret.delete` (beginDelete + poll — **soft**; it used to purge right
after, which destroyed recoverable data and failed on purge-protected vaults
after the soft delete had already landed). Missing objects answer 404 with
code `SecretNotFound` / `KeyNotFound` / `CertificateNotFound`; 409 maps to
`ResourceConflictError` (being deleted, purge protection), 400 to
`ResourceInvalidRequestError`.

Capabilities: vault category, port 443, no SSH tunnel, the full `vault.*`
set. Labels: Vault/Secrets.

## Testing

`tests/integration/resources/azure-key-vault-provider.test.ts` doubles the
three SDKs and @azure/identity with `mock.module` — there is NO emulator
(the documented limitation), so these tests are mock-anchored to the SDKs'
documented contracts. The fake counts `getSecret` calls, so "opening a
secret never reads its value" is asserted. Routes:
`tests/api/resources/vault-routes.test.ts`, exclusions and admin API:
`tests/api/resources/vault-exclusions.test.ts`; UI:
`tests/components/resources/vault/`.

## Known limitations

- No managed HSM, no certificate creation / issuer management / policy
  editing (import only), no key rotation policy, no key operations
  (encrypt/sign) from the UI.
- Listings stop at 1000 objects and version lists at 100 (flagged).
- Editing properties cannot clear an expiry (Key Vault's PATCH ignores an
  absent field); save a new value without one instead.
- Tags on an edit are re-entered whole: the form never pre-fills.
- RBAC vs access-policy differences surface as the service's own errors.
