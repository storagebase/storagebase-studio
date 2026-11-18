# Redis Sentinel (fork interim, seam S4)

Redis Sentinel support until upstream takes the PR: a connection string the upstream redis
provider does not read, parsed into ioredis's Sentinel options by fork code, spread into the
provider's `new Redis({...})` by the one registered seam. The builder is
`src/storagebase/redis-sentinel/options.ts`; the seam is row S4 of `SEAMS.md` and costs exactly
two upstream lines; the contract that keeps upstream behaviour bit-identical is that
`storagebaseSentinelOptions()` answers `{}` for every connection that does not carry a Sentinel
string.

Behavioural spec: the old fork's Sentinel support (`legacy/0.16-main`, `keyvalue/redis.ts`, and
its measured notes in `docs/providers/redis.md` §4.4 as it stood there), re-expressed through
the string instead of the connection fields the old fork had added.

## 1. The connection string

```text
redis-sentinel://[:password@]host1[:port][,host2[:port][,…]][/<db>][?name=<masterName>[&sentinelPassword=<pw>]]
rediss-sentinel://…   — the same, with TLS to the sentinels and to the master
```

- **Nodes.** Comma-separated `host[:port]`; a node without a port takes Sentinel's own `26379`;
  blanks are dropped; `[::1]:26380` is an IPv6 host. A port that is not a TCP port (`h:abc`,
  `h:`, `h:70000`) and an unbracketed IPv6 address refuse the whole string.
- **`name=` (required).** The master group the sentinels monitor. Without it there is nothing to
  ask the sentinels for — ioredis's own `SentinelConnector` throws `Requires the name of
  master.` — so a string without it is refused here.
- **`:password@`.** The Redis AUTH password, percent-encoded when it contains `@`, `&`, `%` or
  `?` (a second unescaped `@` refuses the string rather than being guessed at). No ACL user in
  the string: the connection's `user` field names it, the way upstream reads it.
- **`sentinelPassword=`.** The sentinels' own AUTH. Absent, it falls back to `:password@`, then
  to the connection's `password` field — the one-secret chart deployment (Bitnami's
  `sentinel.enabled`) needs nothing else, and a sentinel that requires no password still
  answers (ioredis logs the refused AUTH and carries on).
- **`/<db>`.** The numbered database, selected by the driver at connect. Absent, the
  connection's own `database` field decides, as ever; when both are set, keep them in
  agreement — upstream's post-connect `SELECT` lands the session in the field's.
- **`rediss-sentinel://`.** TLS, one setting covering both hops (`tls` +
  `enableTLSForSentinelMode: true` for the master the sentinels resolved, `sentinelTLS` for the
  sentinels — without that pair ioredis speaks plaintext to both whatever else it carries). The
  object is `{ rejectUnauthorized: false }`, exactly upstream's mapping of the secure *scheme*
  for redis (`rediss://` → sslMode `require`): a self-hosted sentinel deployment presents a
  self-signed certificate by default, and a chain-checking object here would refuse the
  ordinary install. The string carries no certificate material, so the connection's SSL panel
  cannot be honoured from it — the plaintext spelling ignores the panel in Sentinel mode; use
  the secure spelling for TLS.
- **Refusals, never throws.** Anything malformed — an unknown query parameter, a `#` fragment,
  `user:password@`, a path that is not a number, a parameter without `=` — answers `null`, and
  the connection degrades to the standalone one its fields describe, failing in upstream's own
  words rather than half-connecting somewhere the operator never fully said.

Pinned by `tests/storagebase/unit/redis-sentinel/options.test.ts`.

## 2. The S4 seam

Two added lines in `src/lib/db/providers/keyvalue/redis.ts` and nothing else (budget +2/−0,
`scripts/storagebase/seam-check.mjs` enforces it):

```ts
import { storagebaseSentinelOptions } from "@/storagebase/redis-sentinel/options";
// …
const client = new Redis({
  ...this.redisOptions(),
  ...storagebaseSentinelOptions(this.config),
  ...(commandTimeout === undefined ? {} : oneCommandOptions(commandTimeout)),
});
```

For a Sentinel string, ioredis switches to its `SentinelConnector` on the presence of
`sentinels` alone, and asks the sentinels for the current master on every connect and reconnect
— which is what makes a failover transparent. The options upstream built ride along untouched:
`host`/`port` are inert in Sentinel mode, `connectTimeout` is what the sentinel hops take too.
The bounded `sentinelRetryStrategy` (the whole list 200/400/600 ms apart, then give up for good
— ioredis's default retries forever and a connection test would hang with no sentence) is
ported unchanged from the old fork.

## 3. IMPORTANT — what can carry the string at this ref

**A seed cannot.** The seed schema refuses `connectionString` on a `redis` connection
(`CONNECTION_STRING_ACCEPTED.redis` is `false`, src/lib/seed/types.ts superRefines it out),
and the connection form's paste row claims only `redis://` and `rediss://`. Nothing to fix on
the fork side: enabling either is a multi-file upstream change that would burn exactly the hot
files the re-fork exists to avoid.

**A connection an API caller supplies inline can.** `resolveConnection` returns an inline
connection verbatim (it checks `type` and `name`, not `connectionString`), so a
`POST /api/db/*` body carrying a full connection object with `connectionString` set reaches the
provider with the string intact. Until the upstream PR lands, that is the seam's whole reach:
a client or script that posts its own Sentinel connection; the operator's seed file cannot
name one. Set `ALLOW_CUSTOM_CONNECTIONS` accordingly if that path is wanted.

## 4. The upstream PR (the seam's exit)

Real Sentinel support is generic upstream quality (P7), so the interim is a bridge, not the
destination: the coordinator prepares an upstream PR that adds Sentinel to upstream's redis
provider the way the old fork had it — `sentinels` / `sentinelMasterName` / `sentinelPassword`
connection fields, the connection form, the seed schema, `docs/providers/redis.md` §4.4, and
the provider-side pieces the interim cannot carry within two lines:

- `parseSentinelNodes` validation in `validate()` (no master name / no node / SSH-tunnel
  refusal — a tunnel has no host:port to forward);
- the `end` → `setConnected(false)` handler in `connect()`, so a client the bounded retries
  have ended for good stops reporting itself connected and the provider cache opens a fresh
  one (upstream's redis provider has no `end` listener at this ref).

When it merges, delete the two seam lines, the S4 row in `SEAMS.md`, and this module's callers
— the builder and this doc go with them, and the fork carries nothing.

## 5. The compose fixture

`deploy/storagebase/compose.yml` — one redis master, one replica, three sentinels (quorum 2),
no auth, `redis:7-alpine`:

```bash
docker compose -f deploy/storagebase/compose.yml up -d
docker compose -f deploy/storagebase/compose.yml ps
docker compose -f deploy/storagebase/compose.yml exec sentinel-1 \
  redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
```

The sentinels announce the master by hostname, so a live client must share the compose network
(`sentinel-net`): run the studio — or the future `tests/live/redis-sentinel.ts` probe — as
another service on it, and connect with:

```text
redis-sentinel://sentinel-1:26379,sentinel-2:26379,sentinel-3:26379?name=mymaster
```

A failover drill is `docker compose … stop redis-master` and a reconnect. The file's header
documents the auth-on variant (`--requirepass` + `sentinel auth-pass`, the one-secret default
it exercises).

## 6. Known interim limitations

- The connect-failure sentence names `host:port` (upstream's `connectFailure`), which a
  Sentinel connection has neither of — the master's address is only known after the sentinels
  answer. Cosmetic; fixing it is upstream-PR work (§4).
- After a reconnect whose bounded retries run out, ioredis ends the client for good; without
  the old fork's `end` handler (§4) the provider keeps reporting itself connected on that dead
  client until its next command fails. The cache then opens a fresh one.
- `db` from the path selects the database at connect; upstream's post-connect `SELECT` still
  lands the session in the `database` field when both are set (§1).
- The old fork's `validate()` refused Sentinel through an SSH tunnel (the factory forwards
  `host:port` through a bastion, and a Sentinel connection has neither, so the traffic would
  go around it). The interim cannot refuse anything — `storagebaseSentinelOptions` answers
  options, not verdicts — so an inline Sentinel connection with `sshTunnel` set connects
  around the bastion. Do not set a tunnel on one; the upstream PR carries the refusal.
