import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DB_UI_CONFIG, takesConnectionField, type ConnectionField } from "@/lib/db-ui-config";
import {
  RESOURCE_TYPE_ORDER,
  RESOURCE_UI_CONFIG,
  takesResourceConnectionField,
  type ResourceConnectionField,
} from "@/lib/resources/ui-config";
import type { ManagedConnectionKind } from "@/lib/access/types";
import type { ResourceType } from "@/lib/resources/types";
import type { DatabaseType } from "@/lib/types";

/**
 * Which inputs the managed-connection form renders (StorageBase fork), read off the same field
 * lists the user's own connection forms read (`DB_UI_CONFIG.connectionFields`,
 * `RESOURCE_UI_CONFIG.connectionFields`), so an engine never asks here for a field it does not take.
 * Secret fields are write-only: the server never sends them back.
 */

export interface FieldSpec {
  key: string;
  label: string;
  secret: boolean;
  numeric: boolean;
}

const DATABASE_FIELDS: ReadonlyArray<[ConnectionField, string]> = [
  ["host", "Host"],
  ["port", "Port"],
  ["user", "User"],
  ["password", "Password"],
  ["database", "Database"],
  ["schema", "Schema"],
  ["connectionString", "Connection string"],
  ["serviceName", "Service name"],
  ["instanceName", "Instance name"],
  ["localDataCenter", "Local data centre"],
  ["authSource", "Auth source"],
  ["sentinels", "Sentinels (host:port, …)"],
  ["sentinelMasterName", "Sentinel master name"],
  ["sentinelPassword", "Sentinel password"],
];

const RESOURCE_FIELDS: ReadonlyArray<[ResourceConnectionField, string]> = [
  ["endpoint", "Endpoint"],
  ["region", "Region"],
  ["accessKeyId", "Access key id"],
  ["secretAccessKey", "Secret access key"],
  ["sessionToken", "Session token"],
  ["connectionString", "Connection string"],
  ["token", "Token"],
  ["tenantId", "Tenant id"],
  ["clientId", "Client id"],
  ["clientSecret", "Client secret"],
  ["accountKey", "Account key"],
  ["vaultName", "Vault name"],
  ["namespace", "Namespace"],
];

/** The credential fields, mirroring the storage layer's classification (src/lib/storage/connection-secrets.ts). */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "password",
  "sentinelPassword",
  "connectionString",
  "secretAccessKey",
  "sessionToken",
  "token",
  "clientSecret",
  "accountKey",
]);

export function fieldsFor(kind: ManagedConnectionKind, type: string): FieldSpec[] {
  const spec = (key: string, label: string): FieldSpec => ({
    key,
    label,
    secret: SECRET_FIELDS.has(key),
    numeric: key === "port",
  });
  if (kind === "database") {
    if (!Object.hasOwn(DB_UI_CONFIG, type)) return [];
    return DATABASE_FIELDS.filter(([key]) => takesConnectionField(type as DatabaseType, key)).map(([key, label]) =>
      spec(key, label),
    );
  }
  if (!Object.hasOwn(RESOURCE_UI_CONFIG, type)) return [];
  return RESOURCE_FIELDS.filter(([key]) => takesResourceConnectionField(type as ResourceType, key)).map(
    ([key, label]) => spec(key, label),
  );
}

export interface TypeOption {
  value: string;
  label: string;
}

export function typeOptions(kind: ManagedConnectionKind): TypeOption[] {
  return kind === "database"
    ? SHIPPED_DATABASE_TYPES.map((type) => ({ value: type, label: DB_UI_CONFIG[type].label }))
    : RESOURCE_TYPE_ORDER.map((type) => ({ value: type, label: RESOURCE_UI_CONFIG[type].label }));
}

export function typeLabel(kind: ManagedConnectionKind, type: string): string {
  return typeOptions(kind).find((option) => option.value === type)?.label ?? type;
}

export const ENVIRONMENTS = ["production", "staging", "development", "local", "other"] as const;
