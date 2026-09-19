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
  unrecoverable after 30 days, not today. Forcing would make the viewer's
  confirm promise less than the API delivers in reverse.

Capabilities: vault category, port 443, no SSH tunnel. Labels: Secrets/Secrets.

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
