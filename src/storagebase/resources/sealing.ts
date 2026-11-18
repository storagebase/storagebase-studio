import { encryptSecret, readSecret } from "@/lib/storage/encryption";
import { ResourceConfigError } from "./errors";
import { SECRET_RESOURCE_FIELDS, type ResourceConnectionField } from "./ui-config";
import type { ResourceConnection, ResourceConnectionRow, ResourcePermission } from "./types";

/**
 * Credential sealing for fork resource connections, on upstream's AES-GCM
 * envelope (imported, never edited — P4). The stored record of kind
 * `"resource-connection"` carries each secret field as a `v1:<iv>:<body+tag>`
 * envelope, exactly as upstream's storage layer seals a database password: a
 * leaked store file is useless on its own, and the browser NEVER receives a
 * secret value — the row builder at the bottom of this file whitelists what
 * leaves the server, reading the same `SECRET_RESOURCE_FIELDS` classification.
 *
 * Sealing throws when upstream's key material is missing — deliberately, and
 * failing CLOSED: a write that could not encrypt must not fall back to
 * writing the credential in the clear (the upstream encryptSecret ruling).
 */

/** The connection fields sealing touches, in a stable order for deterministic tests. */
export const SEALABLE_FIELDS: readonly ResourceConnectionField[] = [...SECRET_RESOURCE_FIELDS];

/**
 * Seals every secret field the values carry, and nothing else: the update path
 * seals only what it is replacing, so the envelopes it is NOT replacing pass
 * through untouched (sealing an envelope again would bury the credential one
 * key rotation deeper). Empty and absent fields stay absent — an empty secret
 * is no credential, and storing `""` (or an envelope of it) would make the
 * "has credential" marker a lie.
 */
export function sealResourceSecretFields(
  values: Partial<Record<ResourceConnectionField, string>>,
): Partial<Record<ResourceConnectionField, string>> {
  const sealed: Partial<Record<ResourceConnectionField, string>> = {};
  for (const field of SEALABLE_FIELDS) {
    const value = values[field];
    if (typeof value === "string" && value !== "") sealed[field] = encryptSecret(value);
  }
  return sealed;
}

/**
 * Seals a whole connection for the store: every secret field with a value
 * becomes an envelope, every secret field without one is dropped, and the
 * non-secret fields pass through untouched.
 */
export function sealResourceConnection(connection: ResourceConnection): ResourceConnection {
  const sealed: ResourceConnection = { ...connection };
  for (const field of SEALABLE_FIELDS) delete sealed[field];
  return { ...sealed, ...sealResourceSecretFields(connection) };
}

/**
 * Opens a stored record for provider use: every secret field that holds a
 * `v1` envelope is decrypted back to its plaintext, server-side only. A
 * plaintext value predates sealing and passes through (upstream's lazy-migration
 * ruling — the next write envelopes it). A value that CLAIMS to be an envelope
 * but cannot be opened (a rotated key, a truncated or tampered record) is a
 * refusal, not a silent drop: handing the provider an empty field would
 * surface as an authentication failure with no diagnosable cause, so the
 * connection answers `SB_RESOURCE_CONFIG_ERROR` naming the field to re-enter.
 */
export function openSealedResourceConnection(record: ResourceConnection): ResourceConnection {
  const opened: ResourceConnection = { ...record };
  for (const field of SEALABLE_FIELDS) {
    const value = opened[field];
    if (typeof value !== "string" || value === "") continue;
    const read = readSecret(value);
    if (read.kind === "plaintext") continue;
    if (read.kind === "decrypted") {
      opened[field] = read.value;
      continue;
    }
    throw new ResourceConfigError(
      `The stored credential for "${field}" on connection "${record.name}" could not be decrypted (a rotated or changed encryption key). Re-enter it on the connection and save.`,
    );
  }
  return opened;
}

/**
 * Whether a connection (sealed or not) carries any credential the server can
 * use: any secret field with a non-empty value. Drives the row's
 * `hasCredential` marker, and exists so the marker answers from the one
 * classification rather than a per-route guess.
 */
export function resourceConnectionHasCredential(connection: ResourceConnection): boolean {
  return SEALABLE_FIELDS.some((field) => {
    const value = connection[field];
    return typeof value === "string" && value !== "";
  });
}

/**
 * The connection as the browser may see it: a WHITELIST of non-secret
 * presentation and addressing fields plus the `hasCredential` marker — never a
 * secret value, so a field added to `ResourceConnection` later reaches the
 * browser only when someone adds it to this list on purpose. Seeded rows carry
 * `seeded: true` and the permission the entry's roles grant, so the UI
 * withholds edit/delete (always) and write controls (below `write`).
 */
export function resourceConnectionRow(
  connection: ResourceConnection,
  seeded?: { permission: ResourcePermission },
): ResourceConnectionRow {
  const row: ResourceConnectionRow = {
    id: connection.id,
    name: connection.name,
    type: connection.type,
    createdAt: connection.createdAt,
    ...(connection.color !== undefined ? { color: connection.color } : {}),
    ...(connection.environment !== undefined ? { environment: connection.environment } : {}),
    ...(connection.group !== undefined ? { group: connection.group } : {}),
    ...(connection.endpoint !== undefined ? { endpoint: connection.endpoint } : {}),
    ...(connection.region !== undefined ? { region: connection.region } : {}),
    ...(connection.accessKeyId !== undefined ? { accessKeyId: connection.accessKeyId } : {}),
    ...(connection.tenantId !== undefined ? { tenantId: connection.tenantId } : {}),
    ...(connection.clientId !== undefined ? { clientId: connection.clientId } : {}),
    ...(connection.vaultName !== undefined ? { vaultName: connection.vaultName } : {}),
    ...(connection.namespace !== undefined ? { namespace: connection.namespace } : {}),
    hasCredential: resourceConnectionHasCredential(connection),
  };
  if (seeded !== undefined) {
    row.seeded = true;
    row.permission = seeded.permission;
  }
  return row;
}
