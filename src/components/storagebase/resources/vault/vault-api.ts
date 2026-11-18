import { appFetch } from "@/lib/config/base-path";
import { resourceConnectionBody } from "@/storagebase/resources/connection-body";
import type { ResourceConnection, ResourceOperation } from "@/storagebase/resources/types";
import type { VaultObjectType } from "@/storagebase/resources/operations";

/**
 * The vault workbench's doors to its routes (`/api/sb/vault/<route>`, ported
 * from the old fork's vault-api.ts). `postVault` answers JSON or throws the
 * server's sentence (the Kafka workbench's contract); `readVaultFlags` reads
 * the provider's declared `vault.*` flags without connecting.
 */
export async function postVault<T>(
  connection: ResourceConnection,
  route: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return sendJson<T>(`/api/sb/vault/${route}`, "POST", { ...resourceConnectionBody(connection), ...payload });
}

export async function sendJson<T>(path: string, method: string, payload?: unknown): Promise<T> {
  const response = await appFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

export async function readVaultFlags(connection: ResourceConnection): Promise<ReadonlySet<ResourceOperation>> {
  const meta = await sendJson<{ capabilities: { operations: ResourceOperation[] } }>(
    "/api/sb/resources/meta",
    "POST",
    resourceConnectionBody(connection),
  );
  return new Set(meta.capabilities.operations);
}

export const TYPE_FLAG: Record<VaultObjectType, ResourceOperation> = {
  secret: "vault.secrets",
  key: "vault.keys",
  certificate: "vault.certificates",
};

export const TYPE_LABEL: Record<VaultObjectType, string> = {
  secret: "Secrets",
  key: "Keys",
  certificate: "Certificates",
};

/** An ISO stamp as a short UTC date-time, or the fallback when absent. */
export function formatDate(value: string | null | undefined, fallback = "—"): string {
  return value ? value.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC") : fallback;
}

/** A `datetime-local` input value to ISO, or undefined when empty. */
export function localToIso(value: string): string | undefined {
  if (value === "") return undefined;
  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

export function tagsText(tags: Readonly<Record<string, string>>): string {
  return Object.entries(tags)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}
