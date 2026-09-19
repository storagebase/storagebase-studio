#!/bin/bash
# LocalStack fixture seed (workstream B). LocalStack runs every executable in
# /etc/localstack/init/ready.d once the edge is up, so this needs no sidecar —
# but it must still be re-runnable, because a recreated container replays it
# against kept volumes. Every command below is create-if-absent.
#
# What exists afterwards, and why:
# - SQS `fixture-events` — the queue the sqs provider browses and publishes
#   to. us-east-1, matching the compose environment.
# - Secrets Manager `storagebase/fixture` — one JSON secret, the shape the
#   secret.read path is measured against.
# - KMS key `alias/fixture` — encrypt/decrypt round-trip target. A key, not
#   the AWS managed one: LocalStack's alias/aws/* keys have fixed ids the
#   fixture must not depend on.
set -eu

awslocal sqs create-queue --queue-name fixture-events --region us-east-1 >/dev/null 2>&1 || true

awslocal secretsmanager create-secret \
  --name storagebase/fixture \
  --secret-string '{"username":"fixture","password":"fixture-pass"}' \
  --region us-east-1 >/dev/null 2>&1 || \
awslocal secretsmanager put-secret-value \
  --secret-id storagebase/fixture \
  --secret-string '{"username":"fixture","password":"fixture-pass"}' \
  --region us-east-1 >/dev/null

awslocal kms create-key --description "storagebase fixture" --region us-east-1 >/dev/null 2>&1 || true
KEY_ID=$(awslocal kms list-keys --region us-east-1 --query 'Keys[0].KeyId' --output text)
awslocal kms create-alias --alias-name alias/fixture --target-key-id "$KEY_ID" --region us-east-1 >/dev/null 2>&1 || true

echo "localstack fixture ready"
