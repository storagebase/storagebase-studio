/**
 * The fork's node-only SDKs, in the one list every consumer derives from (P8).
 *
 * next.config.ts spreads this into `serverExternalPackages` through the S6 seam — the only line
 * upstream's file carries for the fork, so a fork SDK added later spends no new upstream budget.
 * scripts/storagebase/stage-resource-sdks.mjs stages the same set (with its dependency closures)
 * into the standalone Docker payload, because the providers load SDKs through computed dynamic
 * imports that Next's output file tracing cannot see; tests/storagebase holds the two lists equal.
 *
 * Import-free by design, like src/lib/security/headers.ts for upstream's next.config.ts: Next loads
 * config files before any tsconfig path alias exists, so this module must stay dependency-free.
 *
 * The deferred D2 providers (S3, RabbitMQ, SQS, AWS KMS, AWS Secrets Manager, amqplib) add their
 * entries here the day they are ported — nothing else changes.
 */
export const STORAGEBASE_SERVER_EXTERNALS = [
  "@azure/identity",
  "@azure/keyvault-certificates",
  "@azure/keyvault-keys",
  "@azure/keyvault-secrets",
  "@azure/storage-blob",
];
