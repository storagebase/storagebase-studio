import type { NextRequest } from "next/server";
import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import {
  asVaultOperations,
  asVaultWorkbenchOperations,
  VAULT_OBJECT_TYPES,
  type VaultCertificateImport,
  type VaultKeyCreate,
  type VaultObjectType,
  type VaultSecretWrite,
  type VaultWorkbenchOperations,
} from "@/lib/resources/operations";
import { ResourceNotFoundError, ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import { BasicVaultWorkbench, vaultPathOf, vaultTypeOf } from "@/lib/resources/providers/vaults/basic-workbench";
import { loadVaultExclusions } from "@/lib/resources/vault-exclusions-store";
import type { VaultExclusionMatcher } from "@/lib/resources/vault-exclusions";
import { ResourceRouteError, type ResourceRequestContext } from "@/lib/api/resource-route";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";
import type { ResourceConnection, ResourceNode, ResourceNodePage, ResourceOperation } from "@/lib/resources/types";

/**
 * The vault workbench routes' shared half (/api/resources/vault/*): capability
 * gate, the exclusion filter, body validation and the audit wrappers.
 *
 * EXCLUSIONS ARE ENFORCED HERE, ONCE, for every workbench route: the
 * provider is wrapped in `ExcludingVaultWorkbench` before any route sees it,
 * so a list, a version list or a deleted-items list never carries an excluded
 * name, and any by-name call on one answers 404 — the same answer as a name
 * that does not exist, so a rule never confirms what it hides. The legacy
 * /api/resources/secret/* and tree routes apply the same matcher through
 * `requireVisibleSecret` / `filterVaultTree`.
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

function hidden(type: VaultObjectType, name: string): ResourceNotFoundError {
  return new ResourceNotFoundError(`${type} "${name}" does not exist`);
}

/** The workbench as every route sees it: excluded objects do not exist. */
class ExcludingVaultWorkbench implements VaultWorkbenchOperations {
  constructor(
    private readonly inner: VaultWorkbenchOperations,
    private readonly matcher: VaultExclusionMatcher,
  ) {}

  private visible(type: VaultObjectType, name: string): void {
    if (this.matcher.excludes(type, name)) throw hidden(type, name);
  }

  async listVaultObjects(type: VaultObjectType) {
    const listing = await this.inner.listVaultObjects(type);
    return { ...listing, objects: listing.objects.filter((object) => !this.matcher.excludes(type, object.name)) };
  }

  async describeVaultObject(type: VaultObjectType, name: string) {
    this.visible(type, name);
    return this.inner.describeVaultObject(type, name);
  }

  async revealSecret(name: string, version?: string) {
    this.visible("secret", name);
    return this.inner.revealSecret(name, version);
  }

  async saveSecret(name: string, input: VaultSecretWrite) {
    this.visible("secret", name);
    return this.inner.saveSecret(name, input);
  }

  async createKey(name: string, input: VaultKeyCreate) {
    this.visible("key", name);
    return this.inner.createKey(name, input);
  }

  async importCertificate(name: string, input: VaultCertificateImport) {
    this.visible("certificate", name);
    return this.inner.importCertificate(name, input);
  }

  async deleteVaultObject(type: VaultObjectType, name: string) {
    this.visible(type, name);
    return this.inner.deleteVaultObject(type, name);
  }

  async listDeletedVaultObjects(type: VaultObjectType) {
    const deleted = await this.inner.listDeletedVaultObjects(type);
    return deleted.filter((object) => !this.matcher.excludes(type, object.name));
  }

  async recoverDeletedVaultObject(type: VaultObjectType, name: string) {
    this.visible(type, name);
    return this.inner.recoverDeletedVaultObject(type, name);
  }

  async purgeDeletedVaultObject(type: VaultObjectType, name: string) {
    this.visible(type, name);
    return this.inner.purgeDeletedVaultObject(type, name);
  }
}

/** The provider's own workbench, or the generic one over `VaultOperations`; unfiltered. */
export async function resolveRawVaultWorkbench(
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

/** Gate on the object type's flag (and `operation`, when given), then wrap in the exclusion filter. */
export async function resolveVaultWorkbench(
  connection: ResourceConnection,
  type: VaultObjectType,
  operation?: ResourceOperation,
): Promise<VaultWorkbenchOperations> {
  const raw = await resolveRawVaultWorkbench(connection, type, operation);
  return new ExcludingVaultWorkbench(raw, await loadVaultExclusions(connection));
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

// --- The legacy routes' share of the same rule ---

const VAULT_TYPES: ReadonlySet<string> = new Set([
  "azure-key-vault",
  "hashicorp-vault",
  "openbao",
  "aws-secrets-manager",
  "aws-kms",
]);

/** The legacy secret routes' address: `secret/<name>`, `key/<id>` or a Vault `<mount>/<path>`. */
function legacyAddress(path: string): { type: VaultObjectType; name: string } {
  if (path.startsWith("key/")) return { type: "key", name: path.slice("key/".length) };
  return { type: "secret", name: path.replace(/^(mount|secret)\//, "") };
}

/** For /api/resources/secret/*: an excluded path is a 404 before the provider is asked. */
export async function requireVisibleSecret(connection: ResourceConnection, path: string): Promise<void> {
  if (!VAULT_TYPES.has(connection.type)) return;
  const matcher = await loadVaultExclusions(connection);
  const { type, name } = legacyAddress(path);
  const effective: VaultObjectType = connection.type === "aws-kms" ? "key" : type;
  if (matcher.excludes(effective, name)) throw hidden(effective, name);
}

/** For /api/resources/tree: excluded leaves are dropped from a vault's tree levels. */
export async function filterVaultTree(
  connection: ResourceConnection,
  page: ResourceNodePage,
): Promise<ResourceNodePage> {
  if (!VAULT_TYPES.has(connection.type)) return page;
  const matcher = await loadVaultExclusions(connection);
  const keep = (node: ResourceNode) => node.hasChildren || !matcher.excludes(vaultTypeOf(node), vaultPathOf(node));
  return { ...page, nodes: page.nodes.filter(keep) };
}
