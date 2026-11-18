import type { NextRequest } from "next/server";
import { getOrCreateResourceProvider } from "../../factory";
import {
  asVaultOperations,
  asVaultWorkbenchOperations,
  VAULT_OBJECT_TYPES,
  type VaultCertificateImport,
  type VaultKeyCreate,
  type VaultObjectType,
  type VaultSecretWrite,
  type VaultWorkbenchOperations,
} from "../../operations";
import { ResourceOperationUnsupportedError, ResourceRouteError } from "../../errors";
import { BasicVaultWorkbench } from "./basic-workbench";
import { beginResourceWrite, endResourceWrite, type ResourceRequestContext } from "@/storagebase/audit/resource";
import type { ResourceConnection, ResourceOperation } from "../../types";

/**
 * The vault workbench routes' shared half (/api/sb/vault/*), ported from the
 * old fork's src/lib/api/resource-vault-workbench.ts with the exclusion
 * filter REMOVED: decision D3 dropped the admin access model, and the vault
 * exclusion rules — a concept of that model — went with it. There is no
 * ExcludingVaultWorkbench wrapper here and no matcher anywhere else either:
 * what the provider lists is what the route answers.
 *
 * What survived the cut, unchanged: the capability gate, body validation and
 * the audit wrappers. `vaultTarget` and `auditedVaultWrite` carry the
 * decision + outcome pair with one correlation id — the address only, never
 * a value.
 */

/** Object names travel in bodies; Key Vault allows 127 characters, Vault paths more. */
const MAX_NAME = 1024;

/** A certificate file's decoded size ceiling (the upload bound). */
const VAULT_CERTIFICATE_MAX_BYTES = 1024 * 1024;

const TYPE_FLAG: Record<VaultObjectType, ResourceOperation> = {
  secret: "vault.secrets",
  key: "vault.keys",
  certificate: "vault.certificates",
};

/**
 * The workbench as every route sees it: the provider's own when it implements
 * `VaultWorkbenchOperations` (Azure Key Vault), else the generic
 * `BasicVaultWorkbench` over `VaultOperations` (HashiCorp Vault / OpenBao,
 * phase 6). Gate on the object type's flag — and on `operation`, when given.
 */
export async function resolveVaultWorkbench(
  connection: ResourceConnection,
  type: VaultObjectType,
  operation?: ResourceOperation,
): Promise<VaultWorkbenchOperations> {
  const provider = await getOrCreateResourceProvider(connection);
  const declared = provider.getCapabilities().operations;
  const native = asVaultWorkbenchOperations(provider);
  const generic = asVaultOperations(provider);
  if (!declared.includes(TYPE_FLAG[type]) || (native === null && generic === null)) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection holds no ${type}s`);
  }
  if (operation !== undefined && !declared.includes(operation)) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection does not support "${operation}"`);
  }
  return native ?? new BasicVaultWorkbench(provider as unknown as ConstructorParameters<typeof BasicVaultWorkbench>[0]);
}

/** The audit target: the object's address, never its content. */
export function vaultTarget(connection: ResourceConnection, type: VaultObjectType, name?: string): string {
  return `${connection.type}:${type}${name === undefined ? "" : `/${name}`}`;
}

/** An audited workbench write: decision + outcome, one correlation id, request and connection fields. */
export async function auditedVaultWrite<T>(
  context: ResourceRequestContext,
  request: NextRequest,
  action: string,
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const user = context.session.username ?? context.session.role;
  const correlationId = beginResourceWrite(user, action, target, request, context.connection);
  try {
    const result = await run();
    endResourceWrite(user, action, target, correlationId, null, request, context.connection);
    return result;
  } catch (error) {
    endResourceWrite(user, action, target, correlationId, error, request, context.connection);
    throw error;
  }
}

export function requireObjectType(body: Record<string, unknown>): VaultObjectType {
  if (!VAULT_OBJECT_TYPES.includes(body.type as VaultObjectType)) {
    throw new ResourceRouteError(`"type" must be one of ${VAULT_OBJECT_TYPES.join(", ")}`, 400);
  }
  return body.type as VaultObjectType;
}

export function requireObjectName(body: Record<string, unknown>): string {
  const name = body.name;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME) {
    throw new ResourceRouteError(`"name" must be a non-empty string of at most ${MAX_NAME} characters`, 400);
  }
  return name;
}

function optionalTags(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")
  ) {
    throw new ResourceRouteError('"tags" must be a string-to-string map when present', 400);
  }
  return value as Record<string, string>;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ResourceRouteError(`"${field}" must be an ISO date-time when present`, 400);
  }
  return new Date(value).toISOString();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ResourceRouteError(`"${field}" must be a boolean when present`, 400);
  return value;
}

export function requireSecretWrite(body: Record<string, unknown>): VaultSecretWrite {
  if (body.value !== undefined && typeof body.value !== "string") {
    throw new ResourceRouteError('"value" must be a string when present', 400);
  }
  if (body.contentType !== undefined && typeof body.contentType !== "string") {
    throw new ResourceRouteError('"contentType" must be a string when present', 400);
  }
  const tags = optionalTags(body.tags);
  const expiresOn = optionalDate(body.expiresOn, "expiresOn");
  const enabled = optionalBoolean(body.enabled, "enabled");
  return {
    ...(body.value === undefined ? {} : { value: body.value as string }),
    ...(body.contentType === undefined ? {} : { contentType: body.contentType as string }),
    ...(tags === undefined ? {} : { tags }),
    ...(expiresOn === undefined ? {} : { expiresOn }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export function requireKeyCreate(body: Record<string, unknown>): VaultKeyCreate {
  const tags = optionalTags(body.tags);
  const expiresOn = optionalDate(body.expiresOn, "expiresOn");
  const enabled = optionalBoolean(body.enabled, "enabled");
  const common = {
    ...(tags === undefined ? {} : { tags }),
    ...(expiresOn === undefined ? {} : { expiresOn }),
    ...(enabled === undefined ? {} : { enabled }),
  };
  if (body.keyType === "RSA" && [2048, 3072, 4096].includes(body.keySize as number)) {
    return { keyType: "RSA", keySize: body.keySize as 2048 | 3072 | 4096, ...common };
  }
  if (body.keyType === "EC" && ["P-256", "P-384", "P-521"].includes(body.curve as string)) {
    return { keyType: "EC", curve: body.curve as "P-256" | "P-384" | "P-521", ...common };
  }
  throw new ResourceRouteError('A key is RSA with "keySize" 2048/3072/4096, or EC with "curve" P-256/P-384/P-521', 400);
}

export function requireCertificateImport(body: Record<string, unknown>): VaultCertificateImport {
  const contents = body.contentsBase64;
  if (typeof contents !== "string" || contents === "" || !/^[A-Za-z0-9+/=\s]+$/.test(contents)) {
    throw new ResourceRouteError('"contentsBase64" must be the certificate file, base64-encoded', 400);
  }
  if (Buffer.byteLength(contents, "base64") > VAULT_CERTIFICATE_MAX_BYTES) {
    throw new ResourceRouteError(`Certificate files are at most ${VAULT_CERTIFICATE_MAX_BYTES / 1024} KiB`, 400);
  }
  if (body.format !== "pem" && body.format !== "pkcs12") {
    throw new ResourceRouteError('"format" must be "pem" (PEM/CER/CRT) or "pkcs12" (PFX/P12)', 400);
  }
  if (body.password !== undefined && typeof body.password !== "string") {
    throw new ResourceRouteError('"password" must be a string when present', 400);
  }
  const tags = optionalTags(body.tags);
  const enabled = optionalBoolean(body.enabled, "enabled");
  return {
    contentsBase64: contents,
    format: body.format,
    ...(body.password === undefined || body.password === "" ? {} : { password: body.password as string }),
    ...(tags === undefined ? {} : { tags }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}
