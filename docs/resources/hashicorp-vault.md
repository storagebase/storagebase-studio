# HashiCorp Vault provider (`hashicorp-vault`)

## Connection

`endpoint` (server address) + `token`, with an optional `namespace` sent as
`X-Vault-Namespace`. No SDK: the API is plain REST and `node-vault` is
unmaintained (workstream-A decision) — the module speaks HTTP via `fetch`.

## Browse surface

Paths carry their mount (`storagebase/fixture` reads key `fixture` under
kv-v2 mount `storagebase`). Only kv-v2 mounts list — cubbyhole, identity,
transit and sys mounts filter out, because the secret calls could not read
them and an addressable-looking row that 404s is worse than an absent one.
Folders end in `/` with round-tripping ids; an empty prefix answers `[]`,
never 404 (the mount was resolved when drawn — D31 applied to vault paths).

## Values

kv stores objects but `SecretRead.value` is one string: single-key
`{value}` secrets read as the bare value, anything else as JSON. Writes
invert it (JSON text becomes the parsed object, anything else `{value}`).
Both directions are stated here because a caller guessing the rule corrupts
secrets. Delete destroys ALL versions (metadata delete) — the only form the
tree's "delete" can honestly mean; the workbench asks for the typed name.

## Operations

`tree`, `secret.read`, `secret.write`, `secret.delete`. Health reads
`/v1/sys/health`: unsealed is healthy, sealed is degraded (unseal first),
anything else is a failed probe. Reads are audited like writes (the
deliberate exception documented on the read route): secret material access is
what operators filter the trail for.

Capabilities: vault category, port 8200, no SSH tunnel. Labels: Mounts/Secrets.

## Vault workbench

Opens in the main area from the Connections list (`opensWorkbench()`),
served by the generic `BasicVaultWorkbench` over this provider's
`VaultOperations` (src/lib/resources/providers/vaults/basic-workbench.ts):
the tree is flattened into one bounded list (1000 objects, 200 levels) whose
names are the by-name addresses. Declared flags: `vault.secrets`, `vault.secret.reveal`, `vault.secret.write`, `vault.delete` (no properties, keys or certificates). There is no soft
delete here, so the workbench's delete asks for the typed name and says it is
permanent (a metadata delete destroys every version). Details come from the listing, never from a value read;
Reveal is the only call that reads one. Admin exclusion rules apply exactly
as for Azure Key Vault (docs/resources/azure-key-vault.md, "Exclusion
rules"), keyed by the endpoint plus namespace; rules match the full `<mount>/<path>`.

## Testing

`tests/integration/resources/vault-provider.test.ts` doubles HTTP with a
fetch double; answers are shaped from a live pass against Vault 1.21.4 dev
(measured 2026-09-20): mount filtering, folder ids, single-vs-JSON reads,
version bumps on write, destroy-all delete. Live re-verification:
`docker compose -f resources-compose.yml up -d vault vault-init`
(`vault secrets enable -path=storagebase kv-v2` runs in the seed). The dev
token `root` is a fixture credential, never a pattern.

## Known limitations

- kv-v2 only: no cubbyhole, transit, PKI or dynamic-secret engines.
- No version history browsing (read answers the current version + its number).
- Namespace support passes the header through; Enterprise behavior beyond
  that is unprobed.
