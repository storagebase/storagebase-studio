# Amazon SQS provider (`sqs`)

## Connection

Standard AWS addressing: `region` plus keys, with `endpoint` overriding the
service URL for LocalStack (the same override ruling S3 follows). The fixture
endpoint is `http://localhost:4567` (host port dodges RisingWave's 4566 in
the database fleet), region `us-east-1`, credentials `test`/`test`.

## Browse surface

Roots are queues (`queue/<name>`, name taken from the URL's last segment).
Destinations accept the id or the bare name; URLs pass through untouched.

## Peek design

SQS has no non-destructive read, so peeking RECEIVES with
`VisibilityTimeout: 0` — each message is visible again the moment it is
read, at the documented cost of redelivery races with real consumers and
possible duplication and reordering (the plan's risk register, quoted here
because it is the feature's sharpest edge; the viewer states it next to the
list). Up to 10 per round, 10 rounds max; an empty round is the only honest
end-of-queue signal, so `truncated` is measured (stopped short of proof
means more may remain), never assumed. Bodies ride in `meta.preview` (200
chars).

Timestamps: AWS sends `SentTimestamp` in millis; LocalStack v3 sends micros
(measured: year 58688 when multiplied blindly). The provider reads the
magnitude (over 1e14 means micros) instead of trusting either.

## Operations

`tree`, `message.browse`, `message.publish` (attributes become String message
attributes), `message.purge` (the real `PurgeQueue` — AWS allows one purge
per queue per 60 seconds, and that refusal surfaces as-is). FIFO queues need
a `MessageGroupId` on send: `attributes.MessageGroupId` wins, otherwise
`"storagebase"`.

Capabilities: messaging, port 443, no SSH tunnel. Labels: Queues/Messages.

## Testing

`tests/integration/resources/sqs-provider.test.ts` doubles the SDK with
`mock.module`; answers are shaped from a live pass against LocalStack
(`localstack/localstack:3` — `:latest` demands an auth token and exits,
measured) with queue `fixture-events` (measured 2026-09-20). Live
re-verification: `docker compose -f resources-compose.yml up -d localstack`.

## Known limitations

- No FIFO content-deduplication controls in the viewer; no dead-letter
  introspection (the redrive policy is not browsable surface here).
- Purge throttle (60s) is AWS-side; the provider reports the refusal, it
  does not schedule around it.
