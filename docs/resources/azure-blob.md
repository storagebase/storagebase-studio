# Azure Blob Storage provider (`azure-blob`)

## Connection

The account as `endpoint`, or `vaultName` for `https://<vaultName>.blob.core.windows.net`.
Credentials are either Entra ID (`tenantId` + `clientId` + `clientSecret`,
via `ClientSecretCredential`) or `accountKey` (shared key). Either set
validates; neither validates silently.

The shared key exists for one reason: the Azurite emulator speaks no Entra
ID, and without it the fixture below would be unconnectable. The endpoint
passes through untouched for the same measured reason — Azurite spells the
account as the path (`/devstoreaccount1`), and stripping it made list calls
fail with "query parameters invalid".

## Browse surface

Roots are containers (`container/<name>`); levels split on `/` into `prefix`
and `blob` nodes under the same full-address id ruling as S3. `truncated` is
the page's own `continuationToken` (empty means done) — read off the one page,
never a second request, because Azurite rejects the empty-marker peek.

## Operations

`tree`, `blob.read` (getProperties), `blob.download` (range-capable stream),
`blob.upload` (`uploadStream` from the contract's web stream, returns fresh
meta), `blob.delete` (existence-checked first, like S3). Reads and writes map
missing containers/blobs to 404 (`RESOURCE_NOT_FOUND`); Azurite answers those
with statusCode 404, an empty message and no code, so the provider reads the
status and writes its own sentence.

Capabilities: blob category, port 443, no SSH tunnel. Labels: Containers/Blobs.

## Preview

Range reads capped at 64 KiB (`AZURE_BLOB_PREVIEW_LIMIT`), same text/image/binary
ruling as S3.

## Testing

`tests/integration/resources/azure-blob-provider.test.ts` doubles both SDKs
with `mock.module`; every answer is shaped from a live pass against Azurite
(`mcr.microsoft.com/azure-storage/azurite:latest`, measured 2026-09-20):
hierarchy answering `blobPrefixes` + `blobItems` together, missing blobs
answering 404 with an empty message, `exists()` answering plain booleans.
Live re-verification: `docker compose -f resources-compose.yml up -d azurite`,
create a container, connect with the devstore account key. Entra ID has no
emulator — that path is mocked tests only, a documented limitation shared
with the plan's risk register.

## Known limitations

- Uploads through the route are base64-capped at 10 MiB
  (`BLOB_UPLOAD_LIMIT`); larger objects go through the SDK directly.
- No append-blob/page-blob specialization: everything reads and writes as
  block blobs, which is what the fixture and the viewer need.
