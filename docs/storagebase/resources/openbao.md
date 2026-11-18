# OpenBao provider (`openbao`)

Same module as HashiCorp Vault (one module, two ids — the opensearch
precedent): OpenBao is API-compatible for everything this surface touches
(mounts, kv-v2 data and metadata, sys/health, token + namespace headers).
Connection fields, browse surface, values, operations and audit behavior are
identical — see [hashicorp-vault.md](hashicorp-vault.md) for all of it. The
code↔docs↔tests triad for this type-id:

- Code: `src/storagebase/resources/providers/vaults/vault.ts` (shared with
  `hashicorp-vault`)
- Tests: the OpenBao registration/default assertions in
  `tests/storagebase/integration/vault-provider.test.ts`
- This page.

Differences that are OpenBao's own:

- **Defaults.** When a connection omits `endpoint`, the provider uses
  `http://127.0.0.1:8201` (Vault's is `http://127.0.0.1:8200`), and the declared
  `defaultPort` capability is 8201. An explicit `endpoint` always wins.
- **No emulator gap to document:** the `openbao` fixture is a second dev server
  (`openbao/openbao:latest` on host port 8201), seeded by hand rather than the
  vault sidecar so the two fixtures reset independently.
- **Brand-distinct, not merely compatible:** that is why it is its own type-id
  with its own icon and hue rather than an endpoint override (the `s3`
  wire-relative ruling, inverted on purpose).

## Vault workbench

The generic `BasicVaultWorkbench` serves both ids identically: a flattened,
bounded list of secrets whose names are the by-name addresses, details from the
listing, Reveal as the only value read, and a permanent delete (no soft delete
on this API). The declared flags are `vault.secrets`, `vault.secret.reveal`,
`vault.secret.write` and `vault.delete`. The same React workbench that serves
Azure Key Vault drives it through `/api/sb/vault/*`; no second shell is needed.
The generic `/api/sb/secret/{browse,publish,purge}` routes serve it as well.

## Testing

Covered by the shared Vault integration tests plus the explicit OpenBao
registration, default address and default port assertions in the same file. A
divergence in OpenBao's API from Vault's is a provider bug to fix with a version
note here, not silent drift.
