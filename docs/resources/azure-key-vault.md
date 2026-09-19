# Azure Key Vault provider (`azure-key-vault`)

## Connection

The vault as `endpoint`, or `vaultName` for
`https://<vaultName>.vault.azure.net`, with Entra ID (`tenantId` +
`clientId` + `clientSecret` via `ClientSecretCredential`). No shared-key
spelling exists for Key Vault (unlike Blob storage), so none is offered.

## Browse surface

Key Vault has no mounts and no folders: secrets are one flat namespace, so
every secret is a root (`secret/<name>`) addressed by name alone. Prefix
filtering is client-side over the listing.

## Operations

`tree`, `secret.read` (value + version), `secret.write` (setSecret),
`secret.delete` (beginDelete + poll + **purge**: soft-delete alone would
leave the secret recoverable while the viewer reports it gone). Missing
secrets answer 404 with code `SecretNotFound`, which the provider reads.

Capabilities: vault category, port 443, no SSH tunnel. Labels: Vault/Secrets.

## Testing

`tests/integration/resources/azure-key-vault-provider.test.ts` doubles both
SDKs with `mock.module` — there is NO emulator (the documented limitation),
so unlike the fixture families these tests are mock-anchored to the SDKs'
documented contracts rather than a live pass. Shapes follow the SDK
verbatim: paged `{name, enabled, updatedOn}`, `{value, properties.version}`.
If Azure changes those shapes, the tests fail loudly rather than drifting.

## Known limitations

- Secrets only: no keys, no certificates, no managed HSM.
- No version history browsing (reads answer the current version).
- RBAC vs access-policy differences surface as the service's own errors;
  the provider does not interpret them.
