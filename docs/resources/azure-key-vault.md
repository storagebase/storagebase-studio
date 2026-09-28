# Azure Key Vault provider (`azure-key-vault`)

## Connection

The vault as `endpoint`, or `vaultName` for
`https://<vaultName>.vault.azure.net`, with Entra ID (`tenantId` +
`clientId` + `clientSecret` via `ClientSecretCredential`). No shared-key
spelling exists for Key Vault (unlike Blob storage), so none is offered.
Three SDKs share the credential: `@azure/keyvault-secrets`,
`@azure/keyvault-keys` and `@azure/keyvault-certificates` (all
`serverExternalPackages`, staged by `scripts/stage-resource-sdks.mjs`).

Vault connections list on the **Vaults** page (`/vaults`) and open the
**vault workbench** full-page there (`opensWorkbench()`), like Kafka. The
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

One **global** rule list, managed in **Admin → Access → Vault exclusions**
and stored once in the fork settings store (`getForkStore()`, key
`vault-exclusions:global`). A rule is

```
{ id, vaultType: <vault type-id>|any, vaultPattern, vaultPatternKind: exact|glob|regex,
  objectPattern, objectPatternKind: exact|glob|regex,
  objectType: secret|key|certificate|any, enabled, note, updatedBy, updatedAt }
```

and reads "on vaults of `vaultType` whose identity matches `vaultPattern`,
hide `objectType` objects whose name matches `objectPattern`".

**Where the vault identity comes from.** On every vault request the server
takes the connection it runs against — for a managed connection
(`managed:<id>`) the record it resolved and decrypted itself — and derives
the strings a vault pattern is matched against (`vaultIdentities` in
`src/lib/resources/vault-exclusions.ts`). Nothing the browser sends names the
vault: the admin API has no address parameter, and an inline `connection`
riding beside a `connectionId` is ignored. A rule applies when its pattern
matches ANY identity string:

| Vault type | Identity strings (lower-cased) |
|---|---|
| Azure Key Vault | the vault **name** (first DNS label of the vault host), the host, the vault URL. The URL is `endpoint` when set — the provider connects there, so it wins over `vaultName` — else `https://<vaultName>.vault.azure.net`. |
| HashiCorp Vault / OpenBao | the endpoint host, the endpoint URL, and `<url>#<namespace>` when a namespace is set (see their docs) |
| AWS Secrets Manager / KMS | the region, plus the endpoint URL and `<region>@<url>` when an endpoint override is set (see their docs) |

URLs are normalised (lower case, no trailing slash, no default port). A rule
matches the address the connection uses; an alias of the same vault (another
host name for one HashiCorp server, say) is a different identity, so a rule
that must hold everywhere uses a vault-type-wide pattern (`*`).

Enforced server-side on every vault route — workbench, legacy secret routes
and the tree — for everyone, admins included: excluded objects vanish from
lists, version and deleted lists, and any by-name call answers the same 404 a
missing object gets. Matching is case-insensitive for both patterns; globs are
a linear two-pointer match anchored at both ends; regexes are unanchored
(`^…$` anchors them) and restricted at save AND load time (no backreferences
or lookaround, no repeated group containing a repetition or alternation, at
most two unbounded quantifiers, 256-character evaluation bound, 200-character
patterns, at most 500 rules). The compiled list is cached in-process for 10 s
and dropped on every save, so a change applies at once on the replica that
saved it and within 10 s on the others. Fail closed: an unreadable store or an
invalid stored row refuses the vault instead of showing it unfiltered. With
`STORAGE_PROVIDER=local` no store exists, so no rule can be saved (409 with
the reason).

**Migration.** Rules used to be stored per vault as
`vault-exclusions:<type>:<address>`, keyed by an address the browser computed
— which for a managed connection (whose vault name the browser never has)
came out as `https://.vault.azure.net` and applied to no vault. While
`vault-exclusions:global` does not exist, the first read folds every such key
into global rules (`vaultType` = the key's type, `vaultPattern` = the
address, `exact`; ids derived from the key so replicas agree) and writes the
global setting, which ends the migration. Keys whose vault part is empty
(`https://.vault.azure.net`, `#<namespace>` with no endpoint, AWS `default`)
are dropped with a warning; an invalid legacy row refuses (fail closed). The
old keys stay in the table, unread.

Admin API (admin role; every call audited as `resource_operation`, changes
with the rule before and after): `GET /api/resources/admin/vault-exclusions`
(the list, plus `storeAvailable`), `POST` (create), `PUT` (`{ id, ...rule }`),
`DELETE ?id=`; `POST …/preview` (`{ connectionId | connection, rules? }` —
the saved rules or the given drafts; answers `applicableRules` and counts per
type of what they would hide, never names; the listing is read unfiltered on
the server); `POST …/applicable` (the count the workbench's read-only notice
shows admins: "N exclusion rules apply to this vault — manage them in Admin").

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
`tests/api/resources/vault-exclusions.test.ts`, rules and migration:
`tests/unit/lib/resources/vault-exclusions*.test.ts`, end to end on a managed
connection (and no credential in any response):
`tests/security/vault-exclusions-server-side.test.ts`; UI:
`tests/components/resources/vault/`, `tests/components/admin/access/VaultExclusionsPanel.test.tsx`.

## Known limitations

- No managed HSM, no certificate creation / issuer management / policy
  editing (import only), no key rotation policy, no key operations
  (encrypt/sign) from the UI.
- Listings stop at 1000 objects and version lists at 100 (flagged).
- Editing properties cannot clear an expiry (Key Vault's PATCH ignores an
  absent field); save a new value without one instead.
- Tags on an edit are re-entered whole: the form never pre-fills.
- RBAC vs access-policy differences surface as the service's own errors.
