# Azure Blob Storage provider (`azure-blob`)

The fork's write-capable Azure Blob workbench: containers and blobs as a tree,
preview, streaming upload, download and delete — every action audited, every
credential sealed. The code↔docs↔tests triad for this type-id:

- Code: `src/storagebase/resources/providers/blob/azure-blob.ts` (the provider) and
  `blob-route.ts` (the family's route helpers)
- Tests: `tests/storagebase/integration/azure-blob-provider.test.ts`,
  `tests/storagebase/unit/blob/auth-modes.test.ts`,
  `tests/storagebase/api/blob/{blob-reads,blob-writes}.test.ts`,
  `tests/storagebase/components/blob/BlobBrowser.test.tsx`
- This page.

## Connection fields

| field | kind | what it is |
|---|---|---|
| `endpoint` | public | Account URL, e.g. `https://myaccount.blob.core.windows.net`. Passed through untouched — Azurite spells the account as the path (`http://127.0.0.1:10000/devstoreaccount1`), and stripping it broke list calls. |
| `vaultName` | public | The storage account name when `endpoint` is not spelled: builds `https://<vaultName>.blob.core.windows.net`. |
| `tenantId` | public | Entra tenant for client-secret auth, or a workload-identity hint. |
| `clientId` | public | Entra app, a user-assigned managed identity, or a workload-identity hint. |
| `authMode` | public | Optional explicit mode selector — see the matrix below. |
| `accountKey` | **sealed** | Storage account key (shared-key auth). The only credential Azurite speaks. |
| `clientSecret` | **sealed** | Entra client secret. |
| `connectionString` | **sealed** | A storage connection string (`AccountEndpoint=…;AccountKey=…` or a `SharedAccessSignature=…` string). Carries the account and the credential in one line. |
| `sasUrl` | **sealed** | A SAS URL, account- or container/blob-scoped. Carries the token in the query. |

Sealed means the fork store never writes the field in the clear and the browser
never receives it (`SECRET_RESOURCE_FIELDS` → `sealing.ts`); the provider also
never echoes one in a refusal sentence — a 400 names the rule, not the value
(pinned by tests). `sasUrl` is new with this phase and joins `accountKey`,
`connectionString`, `clientSecret`, `token`, `secretAccessKey`, `sessionToken`
and `password` in the sealed set.

## Auth modes

`resolveAzureBlobAuthMode` is the single resolution point; it is a pure function
of the record, so its matrix is unit-tested without an SDK.

| mode | credential built | required fields | account from |
|---|---|---|---|
| `account-key` | `StorageSharedKeyCredential` | `accountKey` | `endpoint` or `vaultName` |
| `connection-string` | the SDK's own `BlobServiceClient.fromConnectionString` parser | `connectionString` | the string itself |
| `sas-url` | the token embedded in the service URL | `sasUrl` (must carry `sig`) | the URL itself |
| `client-secret` | `ClientSecretCredential` | `tenantId` + `clientId` + `clientSecret` | `endpoint` or `vaultName` |
| `managed-identity` | `ManagedIdentityCredential` (user-assigned when `clientId` is present, the pod's system-assigned identity otherwise) | none | `endpoint` or `vaultName` |
| `workload-identity` | `WorkloadIdentityCredential` | none | `endpoint` or `vaultName` |

**Selection.** An explicit `authMode` wins; its required fields are validated at
construction (an unknown value is refused with the valid list). Without one,
the first present credential decides, in this precedence:

`accountKey` → `connectionString` → `sasUrl` → the Entra triple → **`workload-identity`**

so a record with **no credential at all is valid** and resolves to workload
identity — the in-cluster default (REFORK_ANALYSIS 5.3): an AKS deployment with
Microsoft Entra workload identity federation needs no client secret in the
connection. The credential takes `tenantId`/`clientId` from the record when
present; otherwise the AKS-injected `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_FEDERATED_TOKEN_FILE` drive it (the SDK's default resolution).

The shared key exists for one reason: the Azurite emulator speaks no Entra ID,
and without it the fixture would be unconnectable.

## SAS scope

A `sasUrl` may be account-scoped (`https://account…/?sig=…`, full surface) or
container/blob-scoped (`https://account…/<container>[/…]?sig=…`). A scoped
connection is honest about what it can see: the tree's root is exactly the
scoped container (`exists()`-probed, so a dead scope is a 404, not an
empty-looking container), other container names are refused as 404 with the
scope named, and the token itself enforces what inside the container is
readable. Azurite addresses (`http://127.0.0.1:10000/devstoreaccount1/<container>?sig=…`)
are parsed with the account-as-first-segment spelling, the same ruling
`accountName()` applies. Every derived container/blob client inherits the SAS
query from the service URL, so the token never travels in code.

## Browse surface

Roots are containers (`container/<name>`); levels split on `/` into `prefix`
and `blob` nodes under full-address ids (`splitNodeId` is the one splitter).
`truncated` is the page's own `continuationToken` (empty means done) — read
off the one page, never a second request, because Azurite rejects the
empty-marker peek. The listing cap is `AZURE_BLOB_LIST_LIMIT` (1000).

## Routes (`/api/sb/blob/*`)

Every route is a thin wrapper over `handleResourceRequest`
(`src/storagebase/resources/handle-request.ts`): the real upstream `guardRoute`
first (the route-auth census holds), then the body parse, then server-side
connection resolution, then the family helper's capability gate. Writes audit a
decision + outcome pair joined by one correlation id; reads audit one event
with the outcome — the target is always the ADDRESS (`azure-blob:<container>/<blob>`),
never a value.

| route | permission shape | what it does |
|---|---|---|
| `POST /api/sb/blob/meta` | read | One blob's metadata. Audited `blob.meta` with the object's size. |
| `POST /api/sb/blob/preview` | read | A bounded preview: `byteLimit` (default 64 KiB, clamped to `AZURE_BLOB_PREVIEW_LIMIT`), answered as text/image/binary. Range reads only — never the whole blob. |
| `POST /api/sb/blob/download` | read | The bytes as the response body, streamed end to end with `Content-Type`/`Content-Length` from the provider. |
| `POST /api/sb/blob/upload` | write | Streaming upload — see below. Audited `blob.upload`. |
| `POST /api/sb/blob/delete` | write | Delete one blob. Existence-checked first: a missing blob is a 404, not silent idempotency. Two-click confirm lives client-side, the trail lives here. |

Refusals answer the fork's `SB_*` codes: `SB_RESOURCE_NOT_FOUND` (404),
`SB_RESOURCE_OPERATION_UNSUPPORTED` (400), `SB_RESOURCE_CONFIG_ERROR` (400),
`SB_RESOURCE_CONNECTION_ERROR` (502), `SB_STORE_UNAVAILABLE` (503).

## Streaming upload

`POST /api/sb/blob/upload` takes **multipart/form-data**: one `file` part, plus
the addressing fields (`bucket`, `name`) and the connection naming (a
`connectionId`, or a stringified inline `connection` for the pre-save candidate
path). The viewer (`src/components/storagebase/resources/blob/BlobBrowser.tsx`)
builds exactly that form — no base64, no JSON string of megabytes; the legacy
10 MiB base64 cap is gone with the base64 layer.

The body mode is the one the shared handler does not know: the route wraps the
request so the handler's `req.json()` reads the form's fields (file parts stay
`File` values) **after the guard** — guard-before-parse stays the shared
handler's property, and an unauthenticated caller never has its form parsed.
Connection resolution, the rate limit and the error mapping are unchanged and
remain the handler's.

- The file's own stream (`file.stream()`) is what reaches the provider — the
  route never re-buffers it.
- The provider streams through `BlockBlobClient.uploadStream` in explicit
  blocks: `AZURE_BLOB_UPLOAD_BLOCK_SIZE` = 4 MiB × `AZURE_BLOB_UPLOAD_CONCURRENCY`
  = 5 — 20 MiB in flight, independent of the object's size.
- The route's own cap is `BLOB_UPLOAD_LIMIT` = **128 MiB** (`File.size` is known
  before any byte moves, so the 413 costs one stat). The form parser buffers
  the file once; the cap bounds that buffer. Larger objects go through the
  provider SDKs (or azcopy), not this route.
- The size check happens before the audit decision: a refused upload leaves no
  decision event, matching the legacy semantics.

## Workbench guarantees kept from legacy

- Preview is a range read capped at `AZURE_BLOB_PREVIEW_LIMIT` (64 KiB), with
  the text/image/binary verdict and an honest `truncated` flag.
- Full-address node ids round-trip through the one `splitNodeId`; container
  names never contain `/`.
- A missing container answers at first read as a 404, never an empty listing
  that lies about existing.
- A bodiless download is a connection error, not an empty file.
- Deletes are existence-checked first; two-click arming lives in the viewer.
- Audit events carry addresses and counts only — never a blob's bytes, never
  a credential; and a broken audit sink cannot fail the action (the audit API
  is isolated by contract).
- No append-blob/page-blob specialization: everything reads and writes as
  block blobs, which is what the workbench needs.

## Testing

`tests/storagebase/integration/azure-blob-provider.test.ts` doubles the two
Azure SDK modules with `mock.module` and runs the REAL fork spine
(base-provider, registry, factory, sdk-loader); every fake answer is shaped
from a live pass against Azurite (`mcr.microsoft.com/azure-storage/azurite:latest`,
measured 2026-09-20): hierarchy answering `blobPrefixes` + `blobItems` together,
missing blobs answering 404 with an empty message, `exists()` answering plain
booleans. Live re-verification: `docker compose -f resources-compose.yml up -d
azurite`, create a container, connect with the devstore account key.

The auth-mode matrix (workload/managed/SAS/connection-string/key) is
SDK-free and unit-tested in `tests/storagebase/unit/blob/auth-modes.test.ts`;
what those decisions DO once handed to the SDKs is asserted in the integration
test through the constructor arguments. Entra ID and workload identity have no
emulator — those paths are mocked tests only, a documented limitation shared
with the plan's risk register.
