# StorageBase Studio — fork conventions

StorageBase Studio is a fork of [LibreDB Studio](https://github.com/libredb/libredb-studio) that extends
the product beyond databases into three new resource categories: **blob storage** (Azure Blob, S3 and
S3-compatible endpoints), **messaging systems** (Kafka, RabbitMQ, SQS) and **key vaults** (Azure Key
Vault, AWS KMS, AWS Secrets Manager, HashiCorp Vault and Vault-compatible forks such as OpenBao).

This file is fork-owned. It never exists upstream, so it can never conflict.
`CLAUDE.md` and upstream docs describe the database side; where the two disagree on fork policy, this
file wins.

## The one structural rule: the parallel resource layer

The database layers (`src/lib/db/**`, `src/app/api/db/**`, `src/components/object-tree/**`, and the
per-provider triad under `docs/providers/` + `tests/integration/db/`) are **upstream territory**. We
merge them regularly from `libredb/libredb-studio` and do not fork their behaviour. Therefore:

- **Never edit anything under `src/lib/db/` for a resource feature.** If a resource feature seems to
  need it, the design is wrong — bring the capability into the resource layer instead.
- Resource code lives only in these places:
  - `src/lib/resources/**` — providers, factory, types, resource audit vocabulary
  - `src/app/api/resources/**` — the resource API namespace
  - `src/components/resources/**` — resource UI (tree, browsers, viewers)
  - `docs/resources/<type-id>.md` + `tests/integration/resources/<type-id>-provider.test.ts` — the
    resource triad, 1:1 per resource type-id, same PR (mirrors the upstream DB triad rule)
- Importing FROM upstream modules (SSH tunnels, `guardRoute`, storage encryption, masking) is
  encouraged — imports never cause merge conflicts. Editing them is what the rule forbids, with one
  exception: purely additive registration entries in shared registries (for example a new storage
  collection) are allowed when there is no alternative; keep them one-line and append-only.

## Resource type-ids (the only list)

- blob: `azure-blob`, `s3` (S3-compatible endpoints such as MinIO, Cloudflare R2 and DigitalOcean
  Spaces connect through `s3` with an endpoint override; they are wire relatives, not separate ids)
- messaging: `kafka`, `rabbitmq`, `sqs`
- vault: `azure-key-vault`, `aws-kms`, `aws-secrets-manager`, `hashicorp-vault`, `openbao`

The set is defined by the `ResourceType` union in `src/lib/resources/types.ts`, never by prose.

## Branding vs identifiers

The visible product name is **StorageBase Studio**. The fork inherited a large body of package,
registry and tooling identifiers from upstream (`@libredb/studio`, `ghcr.io/libredb/...`, the Helm
chart, the operator CRD group, `LIBREDB_*` env vars, localStorage keys, the `libredb` embedded-store
type-id). These are production identifiers, not brand copy:

- User-visible prose (page titles, login page, banners, README bodies, log/warn messages) says
  StorageBase Studio.
- Identifiers are renamed only through the scripted, guarded release-chain workstream
  (`rename-patch.sh` + the drift-guard scripts and their unit tests), never ad hoc.
- New fork-only configuration uses the `STORAGEBASE_` env prefix. Existing `LIBREDB_*` vars keep
  their names so upstream changes keep merging cleanly.

## Syncing from upstream

See [`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md) for the runbook. Short version: merge
`upstream/main` into `main`, never rebase published history, re-apply the rename patch if the
release-chain workstream has landed, and run the full gate before pushing.
