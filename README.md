<p align="center">
  <img src="public/logo.svg" width="160" alt="StorageBase Studio logo" />
</p>

<h1 align="center">StorageBase Studio</h1>

<p align="center">
  <strong>One web console, deployed next to your data, for your databases and the cloud resources around them.</strong>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/libredb/libredb-studio"><img src="https://img.shields.io/badge/fork%20of-LibreDB%20Studio-blue" alt="Fork of LibreDB Studio"></a>
</p>

---

## What this is

A typical application depends on more than a database. It also has a bucket of files, a queue or
topic that other services publish to, and a vault holding its secrets. Each of these has its own
console, CLI and credentials, and reaching them usually means opening a port or copying keys onto a
laptop.

StorageBase Studio runs as one service inside your network (a container or a Helm release) and
gives the team a single browser UI for all of it. Access goes through one login and one role model,
and every write is recorded in one audit trail.

It is a fork of **[LibreDB Studio](https://github.com/libredb/libredb-studio)** and ships its whole
web SQL IDE unchanged: the query editor, schema explorer, ER diagrams, schema diff, monitoring, the
read-only database agent, OIDC single sign-on and RBAC. The fork adds a resource layer next to that
IDE for blob storage, messaging and key vaults.

> **Database features are documented upstream.** For the full description of the database IDE,
> see the **[LibreDB Studio README](https://github.com/libredb/libredb-studio#readme)**. This README
> covers what the fork adds, and how to build and run it.

---

## What this fork adds

### Resource layer: blobs, queues and key vaults

The resource layer covers ten resource types in three families. They share the database side's
connection dialog, sidebar tree and audit trail. When a service cannot do something, the UI
says so up front instead of letting the request fail.

| Family | Types | What you can do |
| :--- | :--- | :--- |
| Blob storage | Azure Blob Storage, Amazon S3, and S3-compatible endpoints (MinIO, Cloudflare R2, DigitalOcean Spaces) | Browse containers and buckets by prefix; preview text and images (range reads capped at 64 KiB); download, upload and delete objects |
| Messaging | Apache Kafka, RabbitMQ, Amazon SQS | List topics, exchanges and queues; peek messages; publish messages with key, routing key or attributes; purge queues on RabbitMQ and SQS (Kafka has no purge, so the UI does not offer one) |
| Key vaults | Azure Key Vault, AWS Secrets Manager, AWS KMS, HashiCorp Vault, OpenBao | List secrets; read values (masked until you reveal them); write and delete secrets. On AWS KMS, reads return key metadata only, because KMS never exposes key material |

A few service behaviours are worth knowing before you use them:

- **Peeking has a cost on some services.** RabbitMQ requeues every message it peeks, so each one is
  redelivered once. SQS has no non-destructive read, so a peek receives messages with visibility
  timeout 0. Both viewers state this next to the message list.
- **Deletes follow each service's own rules.** Azure Key Vault secrets are deleted and then purged.
  AWS Secrets Manager keeps the default 30-day recovery window. KMS keys are scheduled for deletion
  with the minimum 7-day window. Vault and OpenBao deletes remove every version.
- **Every write is audited.** Uploads, deletes, publishes, purges and secret writes all go to the
  audit trail. Vault and OpenBao secret reads are audited as well.

Each resource type has a doc covering connection fields, browse surface, operations and known
limitations: **[docs/resources/](docs/resources/README.md)**. The local fixture stack (MinIO,
Azurite, Kafka, RabbitMQ, LocalStack, Vault, OpenBao) is `resources-compose.yml`, described in
[docs/resources/compose.md](docs/resources/compose.md).

### In progress on this branch

These features are being built for the next release. They are not finished yet.

- **Kafka workbench.** A Kafka connection gets its own entry in the Connections list, with:
  - the cluster and its brokers
  - topics, with partitions and configuration
  - creating and deleting topics
  - browsing messages by partition, offset or timestamp, with key, headers and a JSON view
  - producing messages
  - consumer groups, with lag and offset reset
- **Redis Sentinel connections.** A Redis connection can point at Sentinel and will follow the
  master when a failover happens.
- **Detailed query audit trail.** Each query records:
  - who ran it, and when
  - the SQL, masked, with literals replaced
  - the client IP (taken from `X-Forwarded-For` when proxy trust is enabled)
  - duration, row count and result

### Roadmap

- **Resource groups mapped to Microsoft Entra ID app roles.** Admins decide which roles can see
  which connections. No group ids are hardcoded.
- **Microsoft Entra ID single sign-on** as an integration you can switch on. It sits beside the
  existing local and generic OIDC providers ([docs/OIDC.md](docs/OIDC.md)).

---

## Database engines (inherited)

The database side comes from upstream and is kept in step with it through regular merges. This fork
does not change its behaviour ([docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md)). Supported engines:

| Engine | Notes |
| :--- | :--- |
| **PostgreSQL** | Full SQL IDE, EXPLAIN plans, transactions, query cancellation |
| **MySQL** | Full SQL IDE, EXPLAIN plans, transactions, query cancellation |
| **Oracle** | Full SQL IDE over the Thin driver, `V$` monitoring views |
| **SQL Server** | Full SQL IDE, `sys.dm_*` DMVs, Azure SQL auto-detect |
| **SQLite** | Server-local file or in-memory database |
| **libSQL** | libSQL server or Turso Cloud over HTTP |
| **DuckDB** | Local DuckDB file or `:memory:` on the server |
| **MongoDB** | JSON query editor and collection operations |
| **Couchbase** | SQL++ IDE with a bucket, scope and collection explorer |
| **ClickHouse** | SQL IDE over the HTTP interface |
| **Apache Druid** | Read-only SQL IDE |
| **Elasticsearch** | Read-only SQL IDE, mapping-driven index explorer |
| **OpenSearch** | Read-only SQL IDE, same module as Elasticsearch |
| **Apache Trino** | Federated SQL across configured catalogs |
| **Apache Cassandra** | CQL IDE, keyspace browser |
| **Redis** | Command editor, key browser, INFO-based monitoring |

There is also an embedded store. Many more engines connect through one of these drivers because they
speak the same wire protocol, for example MariaDB, CockroachDB, Valkey and ScyllaDB. Each engine's
reference, and every wire-compatible engine that has been measured, is listed in
[docs/providers/](docs/providers/README.md).

---

## Getting started

No images or packages are published for this fork. You build the image yourself from this
repository.

| Method | Command |
| :--- | :--- |
| **Docker** | `docker build -t storagebase-studio .` then `docker run -p 3000:3000 storagebase-studio` |
| **From source** | `bun install && bun dev` |
| **Kubernetes** | `helm dependency build charts/storagebase-studio` then `helm install` with your image (below) |

### Docker

```bash
docker build -t storagebase-studio .

docker run -d --name storagebase-studio \
  -p 3000:3000 \
  -v storagebase-data:/app/data \
  -e STORAGE_PROVIDER=sqlite \
  -e STORAGE_SQLITE_PATH=/app/data/storagebase-storage.db \
  storagebase-studio
```

Open <http://localhost:3000>. The command above uses the zero-config first run: if `JWT_SECRET`
and `ADMIN_PASSWORD` are not set, the server generates them on first start and stores them in
`<data dir>/auth-bootstrap.json` (file mode 0600). It prints the admin password to the log once
(`docker logs storagebase-studio`). The admin email defaults to `admin@storagebase.org`.

> If the browser reaches Studio at anything other than localhost or HTTPS (`http://192.168.x.x:3000` on a LAN, for example), also set `AUTH_COOKIE_SECURE=false`. Without it the health check passes while login fails silently and sends you back to the login page.

For a production deployment, set the credentials yourself and turn off generation:

```bash
docker run -d --name storagebase-studio \
  -p 3000:3000 \
  -v storagebase-data:/app/data \
  -e AUTH_BOOTSTRAP=off \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD='change-me' \
  -e STORAGE_PROVIDER=sqlite \
  -e STORAGE_SQLITE_PATH=/app/data/storagebase-storage.db \
  storagebase-studio
```

Notes:

- `JWT_SECRET` must be at least 32 characters. A shorter value makes the server exit at startup.
- `USER_EMAIL` and `USER_PASSWORD` are optional. If you leave them out, the lower-privilege user
  account is not created.
- With `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, the local credentials are not used. See [docs/OIDC.md](docs/OIDC.md).
- `STORAGE_PROVIDER` can be `local` (browser only), `sqlite` or `postgres`. Choose `sqlite` or
  `postgres` to keep connections on the server, which the agent needs
  ([docs/STORAGE.md](docs/STORAGE.md)).
- Every variable, with an example, is in [`.env.example`](.env.example). To enable the AI features,
  set `LLM_PROVIDER`, `LLM_API_KEY` and `LLM_MODEL`.

### From source

Requires [Bun](https://bun.sh/) (the repo pins its version in `package.json`) and Node.js 24+.

```bash
git clone https://github.com/storagebase/storagebase-studio.git
cd storagebase-studio
bun install
cp .env.example .env.local   # edit as needed; zero-config also works here
bun dev                      # http://localhost:3000
```

For local test backends, `database-compose.yml` starts the database engines and
`resources-compose.yml` starts the blob, messaging and vault fixtures.

### Kubernetes (Helm)

The chart is in this repository at [`charts/storagebase-studio`](charts/storagebase-studio/README.md).
Build the image, push it to your own registry, and point the chart at it:

```bash
# Build and push (any registry). On Azure, you can build directly in ACR instead:
#   az acr build --registry <your-registry> --image storagebase-studio:<tag> .
docker build -t <registry>/storagebase-studio:<tag> .
docker push <registry>/storagebase-studio:<tag>

helm dependency build charts/storagebase-studio
helm install storagebase charts/storagebase-studio \
  --set image.repository=<registry>/storagebase-studio \
  --set image.tag=<tag> \
  -f my-values.yaml

# First-run admin credentials, when you did not supply secrets
kubectl logs deployment/storagebase-storagebase-studio | grep -A 4 "generated admin credentials"
```

For production, put the secrets in `my-values.yaml` (`secrets.jwtSecret`, `secrets.adminPassword`)
or point `secrets.existingSecret` at a Secret you manage. The chart also covers Ingress/TLS, a
PostgreSQL subchart, HPA, PDB, NetworkPolicy and seed connections. See the
[chart README](charts/storagebase-studio/README.md) for values, and
[docs/HELM_CHART.md](docs/HELM_CHART.md) for the reasoning behind the design.

---

## Documentation

| Topic | Where |
| :--- | :--- |
| Resource types (blob, messaging, vault) | [docs/resources/](docs/resources/README.md) |
| Database providers | [docs/providers/](docs/providers/README.md) |
| Architecture and data flow | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Server-side storage | [docs/STORAGE.md](docs/STORAGE.md) |
| OIDC single sign-on | [docs/OIDC.md](docs/OIDC.md) |
| Security posture | [docs/SECURITY.md](docs/SECURITY.md) |
| Database agent user guide | [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) |
| Helm chart design | [docs/HELM_CHART.md](docs/HELM_CHART.md) |
| Syncing from upstream | [docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md) |
| Fork conventions (read before contributing) | [STORAGEBASE.md](STORAGEBASE.md) |
| Upstream database feature documentation | [LibreDB Studio README](https://github.com/libredb/libredb-studio#readme) |

---

## Development

The fork has one structural rule: resource code lives in its own layer (`src/lib/resources/**`,
`src/app/api/resources/**`, `src/components/resources/**`) and never requires edits under
`src/lib/db/**`. This keeps upstream merges clean. [STORAGEBASE.md](STORAGEBASE.md) explains the
rule, and [CLAUDE.md](CLAUDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) cover the rest.

```bash
bun run test                                   # every test file, each in its own bun process
bun tests/run-tests.ts tests/unit/x.test.ts    # a single file
bun run test:coverage && bun run coverage:check  # 100% line coverage is a hard gate
bun run format && bun run lint && bun run typecheck
```

Always use `bun run test`, not a bare `bun test` over a directory. Module mocks in bun are
process-wide, so running files together in one process breaks them.

Before you open a pull request, run the same gate CI runs:

```bash
bun run format && bun run lint && bun run typecheck && bun run knip \
  && bun run chart:check && bun run channels:showcase:check \
  && bun run readme:check && bun run security:check \
  && bun run test && bun run build
```

---

## License

MIT, see [LICENSE](LICENSE). StorageBase Studio is a fork of
[LibreDB Studio](https://github.com/libredb/libredb-studio) (Copyright (c) 2025 LibreDB), and the
upstream copyright and license are kept unchanged. One direct dependency, `elkjs`, is under
EPL-2.0. See [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).
