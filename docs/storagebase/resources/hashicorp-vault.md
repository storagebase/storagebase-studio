# HashiCorp Vault provider (`hashicorp-vault`)

The fork's HashiCorp Vault workbench: KV v2 mounts and secrets as a tree, a
bounded flattened object list, reveal/write/delete over plain HTTP, and a
generic secret browse/publish/purge surface. Ported from the legacy fork under
decision D2 (cheap, fork-only). The code↔docs↔tests triad for this type-id:

- Code: `src/storagebase/resources/providers/vaults/vault.ts` (one module serves
  this id and `openbao`, the opensearch precedent),
  `basic-workbench.ts` (the generic workbench),
  `resource-vault.ts` / `resource-vault-workbench.ts` / `resource-secret.ts` (route helpers)
- Routes: `src/app/api/sb/vault/*` (workbench + generic secret read/write/delete)
  and `src/app/api/sb/secret/{browse,publish,purge}`
- Tests: `tests/storagebase/integration/vault-provider.test.ts` (both ids),
  `tests/storagebase/api/secret/secret-routes.test.ts`,
  `tests/storagebase/unit/vault/basic-workbench.test.ts`
- This page.

## Connection fields

| field | kind | what it is |
|---|---|---|
| `endpoint` | public | Server address, e.g. `https://vault.example:8200`. Optional: without one the provider uses `http://127.0.0.1:8200`. A trailing slash is stripped. |
| `namespace` | public | Enterprise namespace, sent as `X-Vault-Namespace` on every request. |
| `token` | **sealed** | The Vault token, sent as `X-Vault-Token`. Required: no token means no anonymous probe. |

Sealed means the fork store never writes the field in the clear and the browser
never receives it (`SECRET_RESOURCE_FIELDS` → `sealing.ts`). This provider does
not implement Kubernetes login: Kubernetes-style auth belongs to upstream's
`${vault:…}` seed credential resolver, which feeds a token into the sealed
field before the workbench ever sees the connection (fork rule P5).

The defaults are type-driven: OpenBao's module defaults to `http://127.0.0.1:8201`
and advertises port 8201; see [openbao.md](openbao.md).

## Browse surface

Paths carry their mount (`storagebase/fixture` reads key `fixture` under the
kv-v2 mount `storagebase`). Only kv-v2 mounts list — cubbyhole, identity,
transit and sys mounts filter out, because the secret calls could not read them
and an addressable-looking row that 404s is worse than an absent one. Folders
end in `/` with round-tripping ids; an empty prefix answers `[]`, never 404
(the mount was resolved when the tree drew it — the D31 ruling, applied to
vault paths).

The generic `/api/sb/secret/browse` route treats `destination` as the mount
(optionally followed by a folder path) and answers at most 100 nodes with an
honest `truncated` flag. `/api/sb/secret/publish` writes `body` to the named
path, folding an optional string-to-string `attributes` map into extra JSON
fields; `/api/sb/secret/purge` deletes the whole secret. Purge needs an `admin`
session and, for a seeded connection, the `admin` permission in
`RESOURCE_ROUTE_PERMISSIONS`.

## Values

kv stores objects but `SecretRead.value` is one string: single-key `{value}`
secrets read as the bare value, anything else as JSON. Writes invert it (JSON
objects become parsed objects, anything else `{value}`). Both directions are
stated here because a caller guessing the rule corrupts secrets. Delete
destroys ALL versions (metadata delete) — the only form the tree's "delete" can
honestly mean; the workbench asks for the typed name.

## Operations

`tree`, `secret.read`, `secret.write`, `secret.delete` plus the workbench
flags `vault.secrets`, `vault.secret.reveal`, `vault.secret.write` and
`vault.delete`. Health reads `/v1/sys/health`: unsealed is healthy, sealed is
degraded (unseal first), standby/recovery are healthy, anything else is a
failed probe. Reads are audited like writes (the deliberate exception
documented on the read routes): secret material access is what operators filter
the trail for. Capabilities: vault category, port 8200, no SSH tunnel. Labels:
Mounts/Secrets.

## Vault workbench

Opens full-page on the Vaults page (`opensWorkbench()` in the fork UI config),
served by the generic `BasicVaultWorkbench` over this provider's
`VaultOperations` (`basic-workbench.ts`): the tree is flattened into one bounded
list (1000 objects, 200 levels) whose names are the by-name addresses. Details
come from the listing, never from a value read; Reveal is the only call that
reads one. There is no soft delete here, so the workbench's delete says the
action is permanent. The same React workbench that serves Azure Key Vault
drives this provider through `/api/sb/vault/*` — no second shell is needed.

Admin-managed vault exclusions from the legacy fork are deliberately **not**
ported: decision D3 replaced the access model with config-only seeds carrying
`roles:` and a `permission` level, and the exclusions were a concept of that
model.

## Known limitations

- kv-v2 only: no cubbyhole, transit, PKI or dynamic-secret engines.
- No version history browsing (read answers the current version + its number).
- Namespace support passes the header through; Enterprise behavior beyond
  that is unprobed.

## Testing

`tests/storagebase/integration/vault-provider.test.ts` doubles HTTP with a
fetch double; answers are shaped from a live pass against Vault 1.21.4 dev
(measured 2026-09-20): mount filtering, folder ids, single-vs-JSON reads,
version bumps on write, destroy-all delete. The same suite asserts both
type-ids resolve through the factory. Live re-verification:
`docker compose -f resources-compose.yml up -d vault vault-init`
(`vault secrets enable -path=storagebase kv-v2` runs in the seed). The dev
token `root` is a fixture credential, never a pattern.
