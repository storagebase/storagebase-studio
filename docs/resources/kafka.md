# Apache Kafka provider (`kafka`)

## Connection

`endpoint` is the bootstrap list (`broker1:9092,broker2:9092`) — the only
addressing Kafka has, which is why the form offers just the one field. No
SASL/TLS surfacing yet: the record carries no credential fields, so a SASL
cluster fails at connect with the broker's sentence rather than as a
half-configured form. SASL/TLS is future work, not silent: the client is
built in one place (`getKafka()`), which is where `ssl` / `sasl` options
land when the connection record grows the fields.

Kafka connections are stored like every resource connection (the
`resource_connections` collection) and created from the same connection
modal (Messaging tab) or the Resources "+". The shell lists them inside the
sidebar's **Connections** list, beside the databases, not under Resources —
see "Workbench" below.

## Browse surface

Roots are topics (`topic/<name>`, `__`-internal topics filtered like the
RabbitMQ `amq.*` set). Topics have no children: messages are browsed through
the viewer, not the tree.

## Peek design

A throwaway consumer group (`storagebase-peek-<connection>-<time>`) reads
from the beginning up to the limit, oldest first, after measuring the total
from per-partition high/low watermarks — `truncated` is computed
(`total > bound`), and an empty topic returns before any consumer starts.
Two implementation rulings, both measured against the fixture, not reasoned:

- `consumer.run()` resolves once fetching STARTS; delivery lands in the
  handler over time. The wait loop (target or 15s deadline,
  `KAFKA_BROWSE_TIMEOUT_MS`), not the `await run`, is what bounds the peek —
  misreading this disconnects before the first fetch answers.
- Never `await consumer.stop()` inside the handler: stop waits for the
  running batch while the handler IS the running batch (deadlock, parked
  forever after the fetch answers). Fire it without awaiting; the outer
  finally performs the awaited stop.

Message bodies ride in node `meta.preview` (200 chars, `previewTruncated`
flag when cut, empty when the body is not UTF-8) on this generic path. Full
bodies, seeking and headers are the workbench read's (`readMessages`, below).

## Operations

Generic (the Resources section and `/api/resources/message/*`): `tree`,
`message.browse`, `message.publish` (key via `attributes.key`, rest as
headers).

Workbench (`KafkaAdminOperations` in `src/lib/resources/operations.ts`,
routes under `/api/resources/kafka/*`), gated by four capability flags:

| Flag | Routes | Provider methods |
|---|---|---|
| `kafka.inspect` | `cluster`, `topics`, `topic`, `messages`, `groups`, `group` | `describeCluster`, `listTopicSummaries`, `describeTopic`, `readMessages`, `listConsumerGroups`, `describeConsumerGroup` |
| `kafka.topic.write` | `topic/create`, `topic/delete`, `topic/partitions`, `topic/config` | `createTopic`, `deleteTopic`, `addPartitions`, `alterTopicConfigs` |
| `kafka.produce` | `produce` | `produceMessage` |
| `kafka.group.write` | `group/reset-offsets`, `group/delete` | `resetConsumerGroupOffsets`, `deleteConsumerGroup` |

Every write is audited as `resource_operation` (decision + outcome, one
correlation id, the caller's address and user agent) with actions
`kafka.topic.create|delete|partitions|config`, `kafka.produce`,
`kafka.group.reset-offsets|delete`; reads audit nothing. Writes follow the
resource-write RBAC precedent: any authenticated session, no admin gate. Never `message.purge`: Kafka has no purge semantic, so the
provider throws `ResourceOperationUnsupportedError` and the capability gate
refuses before any socket opens. Deleting and recreating the topic to fake a
purge would drop consumers' offsets — data loss wearing a feature's clothes.

Capabilities: messaging, port 9092, no SSH tunnel. Labels: Topics/Messages.

## Workbench

Selecting a Kafka connection opens `KafkaWorkbench`
(`src/components/resources/kafka/`) over the editor in the main area — the
editor stays mounted underneath and returns on close or on selecting a
database connection. Three areas:

- **Topics** — list with partitions, replication factor, under-replicated
  count and an approximate message count (sum of high minus low
  watermarks; compaction and transaction markers make it approximate);
  `__*` topics are a toggle, not hidden. Detail: per-partition leader,
  replicas, ISR, earliest/latest offset; configuration with source, edit,
  reset-to-default and add-override; create (name, partitions, RF,
  configs); add partitions (upward only, 409 otherwise); delete with a typed
  name — the route requires `confirm` to repeat the name too.
- **Messages** — seek earliest / newest (tail) / offset / timestamp, one
  partition or all; partition, offset, timestamp, key, value, headers; JSON
  values pretty-printed on expand; non-UTF-8 bytes as base64; a client-side
  filter over the fetched page. Produce with key, value, headers and an
  optional partition.
- **Consumer groups** — state, protocol, members and total lag; detail with
  members (client id, host, decoded assignments) and per-partition
  committed / end offset / lag; reset offsets to earliest / latest /
  timestamp / offset and delete — both only while the group is **Empty**
  (409 with the reason otherwise; the UI disables them up front).
- **Brokers** — cluster id, controller, broker id / host / port / rack.

### Rulings

- **Reads are snapshots, bounded three ways.** `readMessages` plans a window
  per partition against the high watermark at request time (never waits for
  new arrivals), splits the limit across partitions by water-filling
  (`allocateReadQuotas`: short partitions give their share to busy ones, the
  sum never exceeds the limit), caps each value at 64 KiB
  (`valueTruncated`), stops at an 8 MiB page budget, and at the 15 s
  deadline. Page limit 1–200. The throwaway group is fresh with
  `fromBeginning: false`, so unplanned partitions fetch nothing; planned
  ones are `seek`ed right after `run()`. The group is deleted after the
  read (best effort); leftovers list as internal groups.
- **Config edits merge.** kafkajs speaks the legacy AlterConfigs API, which
  REPLACES a topic's whole override set. The provider reads the current
  `TOPIC_CONFIG` overrides and sends them merged with the change; a topic
  with a sensitive override (value not returned) is refused with 409 rather
  than silently reset.
- **Produce refuses unknown topics** before connecting a producer, so a
  broker with `auto.create.topics.enable` never creates a typo.
- **Broker refusals keep their sentence.** Protocol errors map to 400
  (`ResourceInvalidRequestError`: invalid RF/partitions/config, policy),
  409 (`ResourceConflictError`: topic exists, non-empty group, rebalance)
  or 404; everything else is a 502 connection error.
- **Bounded listings.** Message counts are measured for the first 200
  topics (`countsTruncated`), lag for the first 50 non-internal groups
  (`lagTruncated`); end offsets are read once per topic across groups.

## Testing

`tests/integration/resources/kafka-provider.test.ts` doubles kafkajs with
`mock.module`; the fake honors the contract the provider depends on (run
resolves on start with delivery over time, seeks issued after `run()` apply
before the first fetch, offsets report high/low, createTopics answers
`false` for an existing topic, admin errors wrap protocol errors the way
kafkajs does). Routes: `tests/api/resources/kafka-routes.test.ts`; UI:
`tests/components/resources/kafka/`. Live
behavior is verified against the fixture (`apache/kafka:3.9.0`, KRaft,
single-node RF=1 group topics — the RF settings in `resources-compose.yml`
are what make consumer groups elect at all).

Version pairing, measured 2026-09-20: kafkajs 2.2.4 fetches NOTHING from
Kafka 4.3.1 (joins and metadata succeed; record fetches never arrive, while
the Java console consumer reads fine). The fixture pins 3.9.0, the newest
line the client's fetch path is verified against — re-probe before moving it.

## Known limitations

- No SASL/TLS, Schema Registry, Kafka Connect, KSQL or ACLs.
- Broker rack is always empty: kafkajs 2.2.4's `describeCluster` drops it.
- No topic/partition size on disk (kafkajs has no DescribeLogDirs).
- Reads are request/response snapshots, not a live tail.
- The generic Resources peek stays oldest-first; seeking is the workbench's.
