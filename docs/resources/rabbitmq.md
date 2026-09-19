# RabbitMQ provider (`rabbitmq`)

## Connection

`connectionString` (full `amqp://user:pass@host:port/vhost`) or a bare
`endpoint` host (defaults to `amqp://guest:guest@<host>`). Both spellings
because operators keep both around.

## Browse surface and the two protocols

AMQP has no list operation, so discovery rides the management HTTP API
(`GET /api/exchanges|queues`), derived from the AMQP address as
`http://<host>:15672` with the URI's userinfo (guest for bare endpoints). A
broker without the management plugin still publishes and purges; only the
tree explains itself, carrying the derived URL in its sentence.

Roots are exchanges (`exchange/<name>`) and queues (`queue/<name>`), both
leaves. Filtered structurally: the nameless default exchange (unaddressable
for publish) and the `amq.*` predeclared set (broker furniture).

## Peek design

`basic.get` in a loop up to the limit, each message immediately requeued
(`nack(requeue: true)`): the peek leaves the queue as it found it, at the
documented cost of one redelivery per message peeked — the viewer states
this next to the list. Bodies ride in `meta.preview` (200 chars).

Browsing an EXCHANGE is refused (`ResourceOperationUnsupportedError`):
exchanges hold no messages — browse a bound queue. The viewer never offers
the button there in the first place.

## Operations

`tree`, `message.browse`, `message.publish`, `message.purge` (the real
`purgeQueue`). Publish addressing: `queue/<name>` publishes through the
default exchange with the queue name as key; `exchange/<name>` publishes
with `attributes.routingKey` (default `""`); anything else in `attributes`
becomes AMQP headers. Missing queues/exchanges are 404s — and a refused
check closes the CHANNEL server-side, which amqplib also emits as an
`'error'` event: the provider listens (no-op) so the refusal reaches the
catch block as a 404 instead of crashing the process (measured against the
fixture).

Capabilities: messaging, port 5672, no SSH tunnel. Labels: Destinations/Messages.

## Testing

`tests/integration/resources/rabbitmq-provider.test.ts` doubles amqplib with
`mock.module` and the management API with a fetch double; answers are shaped
from a live pass against `rabbitmq:4-management` (measured 2026-09-20):
tree filtering, requeue-on-peek, the 404 channel-close shape, publish
addressing both ways. Live re-verification: `docker compose -f
resources-compose.yml up -d rabbitmq`, user `probe`/`probe`, queue
`fixture.orders`, exchange `fixture.events`.

## Known limitations

- No TLS/AMQPS surfacing beyond `amqps://` URIs passing through; no
  per-message TTL/priority controls in the viewer.
- The management API location is derived, not configured: deployments that
  move it get an honest tree error naming the URL.
