# AWS KMS provider (`aws-kms`)

The deliberate misfit: KMS manages keys, not secrets, and key material can
never be read by design. Rather than refusing the surface, the provider maps
it — every mapping stated here, because an undocumented mapping is a lie:

- **Tree**: keys are roots (`key/<id-or-alias>`), no mounts.
- **Read** answers `describeKey` as JSON: the value is key METADATA (state,
  creation, rotation, algorithms), never material. The workbench masks it like
  every secret view — harmless here, load-bearing everywhere else.
- **Write** creates a key with the text as description. A path of
  `alias/<name>` additionally names an alias; re-writing an existing alias
  retargets it (rotation) via update-after-`AlreadyExistsException`.
  Creation never updates: keys are immutable after birth.
- **Delete** schedules deletion with the minimum 7-day window — the only
  deletion KMS offers, named in the workbench's confirm.

Capabilities: vault category, port 443, no SSH tunnel. Labels: Keys/Keys.
`tree`, `secret.read`, `secret.write`, `secret.delete` all declared against
these mapped meanings.

## Vault workbench

Opens in the main area from the Connections list (`opensWorkbench()`),
served by the generic `BasicVaultWorkbench` over this provider's
`VaultOperations` (src/lib/resources/providers/vaults/basic-workbench.ts):
the tree is flattened into one bounded list (1000 objects, 200 levels) whose
names are the by-name addresses. Declared flags: `vault.keys`, `vault.delete` — a Keys tab only, no reveal and no key creation from the workbench. There is no soft
delete here, so the workbench's delete asks for the typed name and says it is
permanent (deletion is scheduled 7 days out, the minimum KMS allows). Details come from the listing, never from a value read;
Reveal is the only call that reads one. Admin exclusion rules apply exactly
as for Azure Key Vault (docs/resources/azure-key-vault.md, "Exclusion
rules"), keyed by region (+ endpoint override).

## Testing

`tests/integration/resources/aws-vault-providers.test.ts` doubles the SDK
with `mock.module`; answers are shaped from a live pass against LocalStack
(measured 2026-09-20): describe payloads, alias rotation after the expected
`AlreadyExistsException`, the 7-day schedule assertion. Live
re-verification: `docker compose -f resources-compose.yml up -d localstack`.

## Known limitations

- No encrypt/decrypt/data-key operations: this surface manages keys, it does
  not use them. Envelope encryption callers use the SDK directly.
- No alias listing separate from keys (aliases ride the key records).
- Grants, custom key stores and multi-Region keys are out of scope.
