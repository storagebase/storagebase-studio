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
`resource_connections` collection) and created from the **Messaging** page
(`/messaging`, its "+"), which lists them beside the RabbitMQ and SQS
connections — see "Workbench" below.

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

Generic (`/api/resources/message/*`, for API callers; the UI uses the workbench): `tree`,
`message.browse`, `message.publish` (key via `attributes.key`, rest as
headers).

Workbench (`KafkaAdminOperations` in `src/lib/resources/operations.ts`,
routes under `/api/resources/kafka/*`), gated by four capability flags:

| Flag | Routes | Provider methods |
|---|---|---|
| `kafka.inspect` | `cluster`, `topics`, `topics/counts`, `topic`, `messages`, `groups`, `groups/lag`, `group` | `describeCluster`, `listTopicSummaries`, `countTopicMessages`, `describeTopic`, `readMessages`, `listConsumerGroups`, `measureGroupLag`, `describeConsumerGroup` |
| `kafka.topic.write` | `topic/create`, `topic/delete`, `topic/partitions`, `topic/config` | `createTopic`, `deleteTopic`, `addPartitions`, `alterTopicConfigs` |
| `kafka.produce` | `produce` | `produceMessage` |
| `kafka.group.write` | `group/reset-offsets`, `group/delete` | `resetConsumerGroupOffsets`, `deleteConsumerGroup` |

Every write is audited as `resource_operation` (decision + outcome, one
correlation id, the caller's address and user agent) with actions
`kafka.topic.create|delete|partitions|config`, `kafka.produce`,
`kafka.group.reset-offsets|delete`. Every read is audited too, as one
`resource_operation` event with its outcome (`kafka.cluster.read`, `kafka.topics.list`,
`kafka.topics.counts` and `kafka.groups.lag` with how many names were measured and how many were
unreadable — never the names — `kafka.topic.read`, `kafka.messages.read` with the topic, partition, seek position, count, bytes
and offset range — never a key, value or header — `kafka.groups.list`, `kafka.group.read`). Writes follow the
resource-write RBAC precedent: any authenticated session, no admin gate. Never `message.purge`: Kafka has no purge semantic, so the
provider throws `ResourceOperationUnsupportedError` and the capability gate
refuses before any socket opens. Deleting and recreating the topic to fake a
purge would drop consumers' offsets — data loss wearing a feature's clothes.

Capabilities: messaging, port 9092, no SSH tunnel. Labels: Topics/Messages.

## Workbench

Selecting a Kafka connection on the Messaging page opens `KafkaWorkbench`
(`src/components/resources/kafka/`) full-page, under the page header that
names the connection and its status. A managed connection granted read opens
it read-only: every write below is withheld, every read stays. Three areas:

- **Topics** — list with partitions, replication factor, under-replicated
  count and an approximate message count (sum of high minus low
  watermarks; compaction and transaction markers make it approximate),
  measured lazily for the rows on screen (see "Lazy listings");
  `__*` topics are a toggle, not hidden; sortable by name, partitions and
  count. Detail: per-partition leader,
  replicas, ISR, earliest/latest offset; configuration with source, edit,
  reset-to-default and add-override; create (name, partitions, RF,
  configs); add partitions (upward only, 409 otherwise); delete with a typed
  name — the route requires `confirm` to repeat the name too.
- **Messages** — seek earliest / newest (tail) / offset / timestamp, one
  partition or all; partition, offset, timestamp, key, value, headers; JSON
  values pretty-printed on expand; non-UTF-8 bytes as base64; a client-side
  filter over the fetched page. Produce with key, value, headers and an
  optional partition.
- **Consumer groups** — kafbat-ui's Consumers layout: Group ID, Num of
  members, Num of topics, Consumer lag, Coordinator and State, every column
  sortable, "Search by Consumer Group ID" and a state filter (All / Stable /
  Rebalancing / Empty / Dead). State is a badge: STABLE green,
  PREPARING_REBALANCE / COMPLETING_REBALANCE (and the pre-2.x AWAITING_SYNC)
  amber "rebalancing", EMPTY grey, DEAD red, anything else UNKNOWN. Detail with
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
- **Offsets are best effort per topic.** Measured on a live cluster: one
  topic whose ListOffsets response came back short made kafkajs throw
  `TypeError: Cannot destructure property 'partitions' of 'high.pop(...)'`
  from inside `fetchTopicOffsets`, and the whole topic list 502'd. Now only
  `listTopics` / metadata failures fail a read. A topic whose offsets cannot
  be read answers `messageCount: null` with `countError` (the UI shows "—"
  with the reason on hover); a topic with no partition metadata or a
  leaderless partition is not asked at all, and a name the cluster does not
  have answers `countError: "topic does not exist"`. Topic detail keeps partitions and
  configs with null offsets and `offsetsError`. Consumer-group lag: an
  unreadable topic's rows get `endOffset: null` + `endOffsetError` (cached,
  so it is tried once per listing), and the group's `totalLag` is null with
  `lagError` — never a partial total that reads as the real one — while the
  rest of the batch still answers. Offset reads run four at a time
  (`KAFKA_OFFSET_CONCURRENCY`) on the shared admin client.
- **Lazy listings.** Measured on a live cluster with 681 topics: the listing
  that counted messages inline (two ListOffsets calls per topic, first 200
  topics) took 7.7 s before answering, and 669 groups' inline lag was the
  same shape. So `topics` is metadata only (one round trip, no offset call
  at any size) and `groups` is ListGroups + DescribeGroups plus one
  `__consumer_offsets` metadata read for the coordinators. Numbers
  come from `topics/counts` (`{ topics: string[] }` →
  `{ counts: { [topic]: { messageCount, countError } } }`) and `groups/lag`
  (`{ groupIds: string[] }` → `{ lags: { [groupId]: { totalLag, lagError, topics } } }`,
  where `topics` counts the distinct topics the group has committed offsets
  on — read off the same OffsetFetch as the lag, so it survives an
  unreadable end offset and is null only when the committed offsets were),
  each bounded to 50 names (`KAFKA_MEASURE_BATCH_LIMIT`, 400 past it) and
  best effort per name. A count batch reads the cluster's metadata once —
  not the named topics, because kafkajs fails the whole metadata answer for
  one unknown name — and a lag batch reads each topic's end offsets once
  across its groups. The UI asks only for the rows the virtualized table
  has on screen (plus its overscan), 150 ms after scrolling or filtering
  settles, 25 names per request, two requests at a time, and caches the
  answers per connection for the session; Refresh forgets them. A pending
  number is a shimmer; an unreadable one or a failed request is "—" with
  the reason on hover, never retried in a loop.
- **Sorting by a lazy number sweeps.** Sorting groups by lag or by topics
  has to be right over every group, not the screenful, so it queues the
  whole filtered list behind the rows on screen through the same batches
  (25 per request, two in flight), shows "Measuring lag n/N…" with Cancel
  (and Resume), and re-sorts as batches land with unmeasured groups last.
  Server side, end offsets are reused across batches for 5 s
  (`endOffsetTtlMs`), so a sweep reads each topic about once rather than
  once per batch; committed offsets stay one OffsetFetch per group, four at
  a time. Every count and lag batch is deadline-bound (20 s): names still
  pending answer "not measured within 20s" and the batch returns.
- **Coordinator without a request per group.** kafkajs finds each group's
  coordinator inside `describeGroups` and discards it; asking again
  (FindCoordinator) costs a request per group. Kafka assigns it
  deterministically — the leader of `__consumer_offsets` partition
  `Utils.abs(groupId.hashCode()) % partitionCount` — so the listing reads
  that topic's metadata once and derives every coordinator
  (`groupOffsetsPartition`, Java's `String.hashCode`). Unreadable metadata or
  a leaderless partition is "—", never a failed listing.
- **Windowed tables.** Topic and group rows are virtualized
  (`@tanstack/react-virtual`, fixed 33 px rows, spacer rows keep it a real
  `<table>` with `aria-rowcount`/`aria-rowindex` and a sticky header), so
  thousands of rows render a screenful. The filter runs on a deferred value
  over the in-memory listing; rows are memoized, so a settled batch
  re-renders only the rows it measured.

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
- Topic counts are only measured for rows that have been on screen, so
  sorting topics by count orders the measured rows first and the rest after
  (group lag and topics sweep every group instead).
- The coordinator is derived from the offsets-topic partitioning, not asked
  of the broker; during a coordinator move it can name the new leader a
  moment before the group has finished loading there.
- A topic whose offsets kafkajs cannot read (short ListOffsets response,
  leaderless partition, mid-deletion) shows no message count, offsets or
  lag — the reason is surfaced, but the numbers are not guessed.
- Reads are request/response snapshots, not a live tail.
- The generic Resources peek stays oldest-first; seeking is the workbench's.
