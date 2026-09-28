import { createHash } from "node:crypto";
import { secretPaths } from "@/lib/access/redact";
import type { UserConnectionFamily } from "./ids";

/**
 * Splitting a user's connection into what the browser may keep and what only the server may hold
 * (StorageBase fork). The secret paths come from the storage layer's classification maps through
 * `secretPaths` — the compile-time-enforced answer to "which fields are credentials" — so a
 * credential field added to a connection type is split out here by construction.
 *
 * Unlike the admin view (`redactConfig`), nothing but the secrets is removed: a user's synced
 * record is theirs, and dropping a field this module does not know would lose their data.
 */

export type ConnectionRow = Record<string, unknown>;
/** Secret path (`password`, `sshTunnel.privateKey`) to value. */
export type SecretBag = Record<string, string>;

/**
 * The fields that decide WHERE a secret is sent. A secret is bound to the target it was saved
 * for: when any of these change and no new secret is supplied, the stored one is not injected —
 * so neither a script in the page nor a stale sync can point a saved password at another host.
 * Transport security is part of the target: turning TLS verification off would hand the same
 * password to whoever sits on the path.
 */
const TARGET_PATHS: Record<UserConnectionFamily, readonly string[]> = {
  database: [
    "type",
    "host",
    "port",
    "sentinels",
    "sentinelMasterName",
    "ssl.mode",
    "ssl.rejectUnauthorized",
    "sshTunnel.enabled",
    "sshTunnel.host",
    "sshTunnel.port",
  ],
  resource: [
    "type",
    "endpoint",
    "region",
    "vaultName",
    "tenantId",
    "sshTunnel.enabled",
    "sshTunnel.host",
    "sshTunnel.port",
  ],
};

export function readPath(row: ConnectionRow, path: string): unknown {
  const [head, tail] = path.split(".");
  if (tail === undefined) return row[head];
  const nested = row[head];
  return typeof nested === "object" && nested !== null ? (nested as ConnectionRow)[tail] : undefined;
}

/** Every secret path this family classifies. */
export function familySecretPaths(family: UserConnectionFamily): string[] {
  return secretPaths(family);
}

/**
 * The row without any secret (and without the server-written `savedSecrets`), and the non-empty
 * secrets it carried. An empty string is "no value", not a secret.
 */
export function extractSecrets(
  family: UserConnectionFamily,
  row: ConnectionRow,
): { stripped: ConnectionRow; secrets: SecretBag } {
  const { savedSecrets: _savedSecrets, ...rest } = row;
  const stripped: ConnectionRow = { ...rest };
  const secrets: SecretBag = {};
  for (const path of familySecretPaths(family)) {
    const [head, tail] = path.split(".");
    const value = readPath(stripped, path);
    if (typeof value === "string" && value.length > 0) secrets[path] = value;
    if (tail === undefined) {
      delete stripped[head];
    } else if (typeof stripped[head] === "object" && stripped[head] !== null) {
      const nested = { ...(stripped[head] as ConnectionRow) };
      delete nested[tail];
      stripped[head] = nested;
    }
  }
  return { stripped, secrets };
}

/** Whether a row still carries any secret value. */
export function carriesSecrets(family: UserConnectionFamily, row: ConnectionRow): boolean {
  return Object.keys(extractSecrets(family, row).secrets).length > 0;
}

/** A digest of the row's target fields: equal exactly when a saved secret may still be sent. */
export function targetFingerprint(family: UserConnectionFamily, row: ConnectionRow): string {
  const target = TARGET_PATHS[family].map((path) => [path, readPath(row, path) ?? null]);
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

/**
 * The row with the secrets written back in. A nested secret needs its container: a tunnel key
 * without a `sshTunnel` block would be a credential for a transport the connection never uses.
 */
export function withSecrets(row: ConnectionRow, secrets: SecretBag): ConnectionRow {
  const out: ConnectionRow = { ...row };
  for (const [path, value] of Object.entries(secrets)) {
    const [head, tail] = path.split(".");
    if (tail === undefined) {
      out[head] = value;
    } else if (typeof out[head] === "object" && out[head] !== null) {
      out[head] = { ...(out[head] as ConnectionRow), [tail]: value };
    }
  }
  return out;
}
