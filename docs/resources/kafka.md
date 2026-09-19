# Apache Kafka provider (`kafka`)

## Connection

`endpoint` is the bootstrap list (`broker1:9092,broker2:9092`) — the only
addressing Kafka has, which is why the form offers just the one field. No
SASL/TLS surfacing in M3: the record carries no credential fields, so a SASL
cluster fails at connect with the broker's sentence rather than as a
half-configured form. SASL is M-future, not silent.

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
flag when cut, empty when the body is not UTF-8). Full bodies are M-future.

## Operations

`tree`, `message.browse`, `message.publish` (key via `attributes.key`, rest
as headers). Never `message.purge`: Kafka has no purge semantic, so the
provider throws `ResourceOperationUnsupportedError` and the capability gate
refuses before any socket opens. Deleting and recreating the topic to fake a
purge would drop consumers' offsets — data loss wearing a feature's clothes.

Capabilities: messaging, port 9092, no SSH tunnel. Labels: Topics/Messages.

## Testing

`tests/integration/resources/kafka-provider.test.ts` doubles kafkajs with
`mock.module`; the fake honors the contract the provider depends on (run
resolves on start with delivery over time, offsets report high/low). Live
behavior is verified against the fixture (`apache/kafka:3.9.0`, KRaft,
single-node RF=1 group topics — the RF settings in `resources-compose.yml`
are what make consumer groups elect at all).

Version pairing, measured 2026-09-20: kafkajs 2.2.4 fetches NOTHING from
Kafka 4.3.1 (joins and metadata succeed; record fetches never arrive, while
the Java console consumer reads fine). The fixture pins 3.9.0, the newest
line the client's fetch path is verified against — re-probe before moving it.

## Known limitations

- No SASL/TLS, no transactions, no headers UI beyond publish attributes.
- Peek is oldest-first only; no seeking to an offset, no tailing.
