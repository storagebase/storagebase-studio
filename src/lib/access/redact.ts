import {
  CONNECTION_FIELDS,
  RESOURCE_CONNECTION_FIELDS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  type FieldClass,
} from "@/lib/storage/connection-secrets";
import type { ManagedConnectionKind } from "./types";

/**
 * What of a managed connection's configuration may leave the server (StorageBase fork).
 *
 * Driven by the storage layer's field classification maps — the compile-time-enforced answer to
 * "which fields are credentials" — rather than a second list of secret names: a credential field
 * added to a connection type is classified there before it can typecheck, and so it is stripped
 * here by construction.
 *
 * Two audiences, two views:
 * - an ADMINISTRATOR editing the connection gets the configuration minus every secret, plus the
 *   paths of the secrets that are set (`password`, `sshTunnel.privateKey`), so the form can say
 *   "set — leave blank to keep";
 * - a USER gets far less than that (src/lib/access/resolve.ts serves only presentation fields),
 *   because the owner's rule is that a preconfigured connection is usable but not viewable.
 */

/** The fields nested groups classify, by the key that holds them. */
const NESTED_MAPS: Record<string, Record<string, FieldClass>> = { ssl: SSL_FIELDS, sshTunnel: SSH_TUNNEL_FIELDS };

function rootMap(kind: ManagedConnectionKind): Record<string, FieldClass> {
  return kind === "database" ? CONNECTION_FIELDS : RESOURCE_CONNECTION_FIELDS;
}

function isSet(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;
}

export interface RedactedConfig {
  config: Record<string, unknown>;
  /** Dotted paths of the secret fields that hold a value. */
  secretsSet: string[];
}

/**
 * The configuration with every secret removed, and which secrets were set. Unknown keys are
 * dropped too: a field nobody classified is not one this view can vouch for.
 */
export function redactConfig(kind: ManagedConnectionKind, config: Record<string, unknown>): RedactedConfig {
  const secretsSet: string[] = [];
  const out: Record<string, unknown> = {};
  const map = rootMap(kind);
  for (const [key, value] of Object.entries(config)) {
    const fieldClass = map[key];
    if (fieldClass === "secret") {
      if (isSet(value)) secretsSet.push(key);
    } else if (fieldClass === "nested" && typeof value === "object" && value !== null) {
      const nestedMap = NESTED_MAPS[key];
      const nested: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        const nestedClass = nestedMap[nestedKey];
        if (nestedClass === "secret") {
          if (isSet(nestedValue)) secretsSet.push(`${key}.${nestedKey}`);
        } else if (nestedClass === "public") {
          nested[nestedKey] = nestedValue;
        }
      }
      out[key] = nested;
    } else if (fieldClass === "public") {
      out[key] = value;
    }
  }
  return { config: out, secretsSet };
}

/** Every secret path a kind's configuration can carry, for the admin form and the leak tests. */
export function secretPaths(kind: ManagedConnectionKind): string[] {
  const paths: string[] = [];
  const map = rootMap(kind);
  for (const [key, fieldClass] of Object.entries(map)) {
    if (fieldClass === "secret") paths.push(key);
    if (fieldClass === "nested") {
      for (const [nestedKey, nestedClass] of Object.entries(NESTED_MAPS[key])) {
        if (nestedClass === "secret") paths.push(`${key}.${nestedKey}`);
      }
    }
  }
  return paths;
}

/**
 * A Helm seed row as `GET /api/connections/managed` serves a `managed: true` seed. The upstream
 * route drops `password` and `connectionString`; the Sentinel password and the TLS client key rode
 * along in the clear, so this drops them too. The browser addresses a managed seed by id, so none
 * of them is ever needed there.
 */
export function withoutSeedSecrets<T extends object>(row: T): T {
  const { sentinelPassword: _sentinelPassword, ...rest } = row as Record<string, unknown>;
  if (typeof rest.ssl !== "object" || rest.ssl === null) return rest as T;
  const { clientKey: _clientKey, ...ssl } = rest.ssl as Record<string, unknown>;
  return { ...rest, ssl } as T;
}
