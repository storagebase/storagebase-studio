# OpenBao provider (`openbao`)

Same module as HashiCorp Vault (one module, two ids): OpenBao is
API-compatible for everything this surface touches (mounts, kv-v2 data and
metadata, sys/health, token + namespace headers). Connection, browse,
values, operations and audit behavior are identical — see
[hashicorp-vault.md](hashicorp-vault.md) for all of it.

Differences that are OpenBao's own:

- No emulator gap to document: the `openbao` fixture is a second dev server
  (`openbao/openbao:latest` on host port 8201), seeded by hand rather than
  the vault sidecar so the two fixtures reset independently. Live pass
  commands are in [compose.md](compose.md).
- Brand-distinct, not merely compatible: that is why it is its own type-id
  with its own icon and hue rather than an endpoint override (the `s3`
  wire-relative ruling, inverted on purpose).

Testing: covered by the shared Vault integration tests plus the
`openbao` registration assertion (both ids resolve through the factory).
A divergence in OpenBao's API from Vault's is a provider bug to fix with a
version note here, not silent drift.

## Vault workbench

Opens in the main area from the Connections list (`opensWorkbench()`),
served by the generic `BasicVaultWorkbench` over this provider's
`VaultOperations` (src/lib/resources/providers/vaults/basic-workbench.ts):
the tree is flattened into one bounded list (1000 objects, 200 levels) whose
names are the by-name addresses. Declared flags: `vault.secrets`, `vault.secret.reveal`, `vault.secret.write`, `vault.delete`. There is no soft
delete here, so the workbench's delete asks for the typed name and says it is
permanent (a metadata delete destroys every version). Details come from the listing, never from a value read;
Reveal is the only call that reads one. Admin exclusion rules apply exactly
as for Azure Key Vault (docs/resources/azure-key-vault.md, "Exclusion
rules"), keyed by the endpoint plus namespace; rules match the full `<mount>/<path>`.
