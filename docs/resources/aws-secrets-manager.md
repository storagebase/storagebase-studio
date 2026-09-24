# AWS Secrets Manager provider (`aws-secrets-manager`)

The natural fit: flat secret names, string values, real create/update/delete.

## Operations

- **Tree**: secrets are roots (`secret/<name>`), one 100-item page with the
  service's `NextToken` as the truncation verdict. Optional name-prefix
  filter passes through as a `name` filter.
- **Read**: `getSecretValue` — `SecretString` verbatim with its version.
  Binary secrets have no text to show: the read refuses with a sentence
  naming the AWS console instead of base64-ing bytes into a text pane.
- **Write** means upsert: `createSecret`, then `putSecretValue` on
  `ResourceExists`. The two calls are the only way to spell it.
- **Delete** uses the DEFAULT recovery window (no force): the secret becomes
  unrecoverable after 30 days, not today. Forcing would make the workbench's
  confirm promise less than the API delivers in reverse.

Capabilities: vault category, port 443, no SSH tunnel. Labels: Secrets/Secrets.

## Vault workbench

Opens in the main area from the Connections list (`opensWorkbench()`),
served by the generic `BasicVaultWorkbench` over this provider's
`VaultOperations` (src/lib/resources/providers/vaults/basic-workbench.ts):
the tree is flattened into one bounded list (1000 objects, 200 levels) whose
names are the by-name addresses. Declared flags: `vault.secrets`, `vault.secret.reveal`, `vault.secret.write`, `vault.delete`. There is no soft
delete here, so the workbench's delete asks for the typed name and says it is
permanent (the service still schedules its 30-day recovery window). Details come from the listing, never from a value read;
Reveal is the only call that reads one. Admin exclusion rules apply exactly
as for Azure Key Vault (docs/resources/azure-key-vault.md, "Exclusion
rules"), keyed by region (+ endpoint override): two accounts in one region share rules, the over-hiding direction.

## Testing

`tests/integration/resources/aws-vault-providers.test.ts` doubles the SDK
with `mock.module`; answers are shaped from a live pass against LocalStack
(measured 2026-09-20): create-then-update upsert, unforced delete assertion,
404 shapes. Live re-verification: `docker compose -f resources-compose.yml
up -d localstack`, secret `storagebase/fixture`.

## Known limitations

- No rotation scheduling UI (rotation needs a Lambda ARN the fixture cannot provide).
- No cross-account replication controls.
- Binary secrets are read-refused (above), never rendered.
