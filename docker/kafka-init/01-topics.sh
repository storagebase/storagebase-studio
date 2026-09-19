#!/bin/bash
# Kafka fixture seed (workstream B). Run by the kafka-init sidecar in
# resources-compose.yml on every `up`.
#
# The broker accepts the port before KRaft elects a leader, so creation
# retries until it answers; past the first run the topics exist and
# `--if-not-exists` keeps the script a no-op. What exists afterwards:
# - `fixture-events` (3 partitions) — the topic the messaging live pass
#   browses and publishes to. Three partitions so a consumer-group read can
#   prove partition spread rather than assert it.
# - `fixture-orders` (1 partition) — the topic the purge path refuses: Kafka
#   has no delete-records-by-topic semantic the provider may call "purge",
#   so this topic is what that refusal is measured against.
set -eu

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9092}"
for i in $(seq 1 30); do
  if kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
  --topic fixture-events --partitions 3 --replication-factor 1
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
  --topic fixture-orders --partitions 1 --replication-factor 1
kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --list
