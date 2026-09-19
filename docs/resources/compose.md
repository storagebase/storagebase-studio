# Resource fixture stack

`resources-compose.yml` boots the fixtures the blob/messaging/vault live
passes measure against — the parallel of `database-compose.yml`, kept in its
own file so either fleet boots without the other. Container names are
`storagebase-*`; host ports dodge everything `database-compose.yml` holds
(RisingWave already owns host 4566 there, so LocalStack serves on 4567).

```bash
docker compose -f resources-compose.yml up -d        # whole stack
docker compose -f resources-compose.yml up -d minio kafka   # one service
```

Seeds run on every `up` and are re-runnable by design; recreating a data
volume replays them from scratch. Mock fidelity in the provider tests is
anchored to a live pass against this stack, same discipline as
`tests/integration/db/*-provider.test.ts`.

## Services

| Service | Image | Host ports | Connect as |
|---|---|---|---|
| `minio` | `quay.io/minio/minio:latest` | 9000 (API), 9001 (console) | `minioadmin` / `minioadmin`, endpoint `http://localhost:9000` |
| `azurite` | `mcr.microsoft.com/azure-storage/azurite:latest` | 10000 (blob) | devstoreaccount1 + the emulator's well-known key (below) |
| `kafka` | `apache/kafka:latest` (KRaft, no ZooKeeper) | 9092 | bootstrap `localhost:9092`, no auth |
| `rabbitmq` | `rabbitmq:4-management` | 5672, 15672 (management) | `probe` / `probe` (`guest` stays localhost-only by policy) |
| `localstack` | `localstack/localstack:latest` (`sqs,kms,secretsmanager`) | 4567 → edge 4566 | `test` / `test`, region `us-east-1`, endpoint `http://localhost:4567` |
| `vault` | `hashicorp/vault:1` (dev, in-memory) | 8200 | token `root` |
| `openbao` | `openbao/openbao:latest` (dev) | 8201 → 8200 | token `root` |

## What is seeded

- **MinIO** (`docker/minio-init/01-buckets.sh` via the `minio-init` sidecar):
  bucket `fixture-blobs` with `hello.txt` and `nested/dir/notes.md` — the
  object that proves prefix delimiting (`nested/` reads as a folder).
- **Azurite**: nothing — the empty account is the fixture. Create a container
  by hand to browse: `az storage container create --name fixture --connection-string
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;
  AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;
  BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;'`.
- **Kafka** (`docker/kafka-init/01-topics.sh` sidecar, retries until KRaft
  elects): `fixture-events` (3 partitions — consumer-group spread is
  measurable) and `fixture-orders` (1 partition — the topic the purge refusal
  is measured against, since Kafka has no purge).
- **RabbitMQ** (`definitions.json` via `load_definitions` at boot):
  topic exchange `fixture.events`, queue `fixture.orders`, binding on
  `orders.#`.
- **LocalStack** (`docker/localstack-init/01-seed.sh`, runs in `ready.d`):
  SQS `fixture-events`, Secrets Manager `storagebase/fixture`
  (`{"username":"fixture","password":"fixture-pass"}`), KMS `alias/fixture`.
- **Vault** (`docker/vault-init/01-seed.sh` sidecar): kv-v2
  `storagebase/fixture` (user/password) and `storagebase/nested/deep` (the
  path-delimiting proof, mirroring the blob prefix object).
- **OpenBao**: unseeded on purpose. It shares the Vault provider module, so
  its live pass replays the Vault seed by hand against `:8201` and proves the
  module, not the seed:
  `export VAULT_ADDR=http://127.0.0.1:8201 VAULT_TOKEN=root &&
  bao secrets enable -path=storagebase kv-v2 &&
  bao kv put storagebase/fixture username=fixture password=fixture-pass`.

## Verify by hand

```bash
mc alias set local http://localhost:9000 minioadmin minioadmin && mc ls --recursive local/fixture-blobs
docker exec storagebase-kafka kafka-topics.sh --bootstrap-server localhost:9092 --list
curl -u probe:probe http://localhost:15672/api/queues
awslocal --endpoint-url=http://localhost:4567 sqs list-queues
export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root && vault kv get storagebase/fixture
```

## Not fixtures

- Azure Key Vault, AWS KMS/SecretsManager against real clouds: mocked tests
  only (documented in the plan's risk register — there is no emulator for
  Key Vault, and LocalStack covers only the AWS fixture surface above).
- Anything production-shaped: dev tokens, `test` credentials and the devstore
  key live in this file because fixtures are not secrets, but nothing here is
  a deployment pattern.
