# Kafka workbench (`kafka`)

The fork's write-capable Kafka workbench at `/messaging`, served by the routes under
`/api/sb/kafka/**`. It is intentionally a SEPARATE surface from upstream's read-only
`stream/kafka` database provider: the same connection record feeds both, but only this
workbench can create topics, produce, reset offsets or delete anything
(`REFORK_ANALYSIS.md` §5.4).

## One connection record

There is **no second Kafka connection record in the fork store**. Every route calls
upstream's `resolveConnection()` with the `{ connection }` / `{ connectionId }` body the
browser sends, so the record is:

- an **upstream `kafka` seed connection** (`connectionId: "seed:<id>"`) — the server
  re-reads it from the operator's seed file after the `roles:` filter, resolves
  `${vault:…}` references and returns decrypted credentials; the caller's copy of the
  record is discarded, including a claimed seed id on an inline object;
- or an inline upstream connection the operator permits (`ALLOW_CUSTOM_CONNECTIONS`).

A record whose `readOnly` flag is set forces the **whole workbench read-only**, whatever
the session's role. The workbench refuses a resolved connection that is not one of the
fork's messaging resource types before it builds a client.

## Client library

`src/storagebase/resources/providers/messaging/kafka-client.ts` is the fork's only
`@platformatic/kafka` importer (SEAMS.md S12, pinned by
`tests/unit/db/kafka/seam-guard.test.ts`). It is a **separate, write-capable** instance
on the same pinned 2.14.0 dependency:

- it calls upstream's `loadPlatformatic()` first for its one global side effect — muting
  the protocol logger, which would otherwise print the first bytes of a SASL PLAIN frame
  (the password) — then imports the full library, including `Producer`, which upstream's
  read-only adapter does not expose;
- the full Admin surface is used: `metadata`, `listTopics`, `listOffsets`,
  `describeConfigs`, `incrementalAlterConfigs`, `createTopics`, `createPartitions`,
  `deleteTopics`, `listGroups`, `describeGroups`, `deleteGroups`,
  `listConsumerGroupOffsets`, `alterConsumerGroupOffsets`, plus `Producer.send` and a
  bounded `Consumer.consume` stream for message reads. **No `kafkajs` fallback was
  needed** — every API the workbench calls exists in the installed typings;
- upstream's `kafkaConnectionOptions` mapping is mirrored in fork code and extended:
  a comma-separated multi-broker `endpoint`, and OAUTHBEARER (a bearer token in the
  `token`/`password` slot) beside PLAIN and SCRAM-SHA-256/512;
- TLS follows upstream's rule — `mode: "disable"` is no TLS, `require` is the only
  non-verifying mode, and any SASL mechanism requires TLS. Credentials containing CR,
  LF or NUL are refused before a socket opens.

`kafka.ts` implements the shared `KafkaAdminOperations` interface over that client. All
reads are bounded and best effort: topic counts, group lag and unreadable partitions
answer a reason beside a `null` figure instead of failing the batch. Offsets travel as
strings (int64 on the wire).

## Routes and permission matrix

Every route is POST and calls `guardRoute({ bucket: "query" })` **before** the body is
parsed. Levels come from `@/storagebase/resources/permissions` (read / write / admin);
admin routes additionally call upstream's `adminRequiredResponse()`.

| Level | Routes |
|---|---|
| read | `cluster`, `topics`, `topics/counts`, `topic`, `messages`, `groups`, `groups/lag`, `group` |
| write | `topic/create`, `topic/partitions`, `topic/config`, `produce` |
| admin | `topic/delete`, `group/reset-offsets`, `group/delete` |

Every read emits one `resource_operation` event with counts only; every write emits a
decision + outcome pair on one correlation id. No route records a message value, key,
header or config value — only the address (topic, partition, seek position, group id)
and small numbers. Deletes require the resource's name to be typed again in the body.

## UI

`KafkaWorkbench` (`src/components/storagebase/resources/kafka/`) opens full-page on a
messaging connection. Topics → detail (overview, messages, config), consumer groups →
detail (offsets, reset, delete), and brokers. Write controls are withheld when the
connection is read-only. Message counts and group lag are measured lazily for the rows
on screen, in bounded batches.

## Parity backlog (deferred, 5.4 change 3)

Not part of the port; each is a fork-only addition with no seams:

- Schema Registry (Avro / Protobuf / JSON decoding and a subjects list)
- live tail
- Kafka Connect
- ACL listing
- log-dir sizes

SASL (PLAIN / SCRAM / OAUTHBEARER) and TLS are **in** the port via the connection
mapping above; GSSAPI is not.
