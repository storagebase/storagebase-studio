import type { SSHTunnelConfig } from "@/lib/types";

/**
 * The fork's resource layer: blob storage, messaging systems and key vaults
 * (STORAGEBASE.md P1: everything lives under `storagebase` paths).
 *
 * This module deliberately does NOT extend `DatabaseType`, `DatabaseConnection`
 * or anything else under `src/lib/db/**` (P3): the database layers stay upstream
 * territory. The shape mirrors what works upstream — a strategy provider behind
 * a factory, capabilities and labels read off the provider without a socket,
 * bounded list reads with an explicit truncation flag — at the weight this
 * surface needs, and no heavier.
 */

/** The three resource categories the fork adds. */
export type ResourceCategory = "blob" | "messaging" | "vault";

/**
 * The fork's resource type-id set. This union is the ONLY list (the rule
 * `EXTERNAL_DATABASE_TYPES` follows upstream); `STORAGEBASE.md` restates it
 * but derives nothing from prose.
 *
 * The D2 decision in force: Azure Blob, Azure Key Vault and Kafka are
 * mandatory; HashiCorp Vault/OpenBao is ported (one module, two ids — the
 * opensearch precedent). S3, RabbitMQ, SQS, AWS KMS and AWS Secrets Manager
 * are DEFERRED until there is a user: they add a `RESOURCE_UI_CONFIG` row and
 * one registry import line the day they land, and nothing in this layer may
 * make that hard.
 */
export type ResourceType = "azure-blob" | "kafka" | "azure-key-vault" | "hashicorp-vault" | "openbao";

/**
 * How a resource connection authenticates. The named modes are the ones the
 * Azure family resolves; the trailing `string` keeps the field open to modes a
 * future provider introduces without another edit here.
 */
export type ResourceAuthMode =
  | "account-key"
  | "connection-string"
  | "sas-url"
  | "client-secret"
  | "managed-identity"
  | "workload-identity"
  | string;

/** Which category a type-id belongs to. Exhaustive, so a new id fails typecheck here first. */
export const RESOURCE_CATEGORY_OF: Record<ResourceType, ResourceCategory> = {
  "azure-blob": "blob",
  kafka: "messaging",
  "azure-key-vault": "vault",
  "hashicorp-vault": "vault",
  openbao: "vault",
};

/** The type-id list as a runtime value, derived from the table so it cannot drift from it. */
export const RESOURCE_TYPES = Object.keys(RESOURCE_CATEGORY_OF) as readonly ResourceType[];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === "string" && Object.hasOwn(RESOURCE_CATEGORY_OF, value);
}

/**
 * One saved resource connection, the parallel of `DatabaseConnection`.
 *
 * Connections live server-side only: user-created ones in the fork store as
 * records of kind `"resource-connection"` (their secret fields sealed by
 * `src/storagebase/resources/sealing.ts`), preconfigured ones in the fork seed
 * file. The browser holds ids and non-secret fields, never a credential — the
 * server-held-secrets model is the default for every resource connection.
 *
 * Addressing is endpoint-shaped rather than host/port-shaped: an Azure account
 * URL, a Vault address, a Kafka bootstrap list. The per-provider field set is
 * optional properties classified once, in `RESOURCE_UI_CONFIG` — the same
 * compile-time enforcement `CONNECTION_FIELDS` gives database connections.
 */
export interface ResourceConnection {
  id: string;
  name: string;
  type: ResourceType;
  createdAt: string;
  color?: string;
  environment?: string;
  group?: string;
  /** Azure account URL, Vault/OpenBao address, Kafka bootstrap list. */
  endpoint?: string;
  /** AWS region. Optional for AWS types; ignored elsewhere. */
  region?: string;
  /** AWS access key id. An identifier, not a credential — the secret access key is the secret. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Temporary AWS session token (STS / assumed roles). */
  sessionToken?: string;
  /** A connection string that carries credentials inline (an amqp:// URL). */
  connectionString?: string;
  /** Vault/OpenBao token, or a bearer token where a service accepts one. */
  token?: string;
  /** A password where a service's credential is a login pair rather than a token or key. */
  password?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /**
   * Storage account key (Azure Blob shared-key auth, and the Azurite emulator
   * which speaks no Entra ID). A credential — sealed at rest. Either this or
   * the Entra triple above; the provider refuses neither silently.
   */
  accountKey?: string;
  /** An explicit authentication mode A provider may resolve (e.g. Azure Blob / Key Vault). */
  authMode?: ResourceAuthMode;
  /** A shared-access-signature URL carrying an inline token. A credential — sealed at rest. */
  sasUrl?: string;
  /** Azure Key Vault name, when the endpoint is not spelled as a full vault URL. */
  vaultName?: string;
  /** HashiCorp Vault / OpenBao Enterprise namespace. */
  namespace?: string;
  /**
   * The grant the connection's DEFINING operator chose for everyone who uses it
   * (D3's config-only model): `read` withholds write affordances, `write` allows
   * non-destructive writes, `admin` allows the irreversible ones. Stored records
   * carry the creator's choice (least privilege `read` when omitted); seeded
   * records carry the grant their roles derive. A route above the grant answers
   * 403, whichever layer the record came from.
   */
  permission?: ResourcePermission;
  sshTunnel?: SSHTunnelConfig;
}

/**
 * A preconfigured connection the fork seed file serves (D3: config-only, no
 * admin access UI). It arrives without credentials — the server resolves them
 * by id — so nothing the UI renders from it can leak one, and it is READ-ONLY
 * from the UI: no edit, no delete, only the file changes it.
 */
export type SeededResourceConnection = ResourceConnection & {
  seeded: true;
  /** What the roles this entry grants may do; a route above it is a 403. */
  permission: ResourcePermission;
};

export function isSeededResourceConnection(conn: ResourceConnection): conn is SeededResourceConnection {
  return (conn as Partial<SeededResourceConnection>).seeded === true;
}

/**
 * Whether every write affordance must be withheld: a connection whose grant is
 * `read`, whichever layer it came from — a seeded entry's role-derived grant or
 * a stored record's creator-set grant. Addresses, names and ids are not
 * credentials, so the row always reveals this.
 */
export function isReadOnlyResourceConnection(conn: ResourceConnection): boolean {
  return conn.permission === "read";
}

/** The fork's operation permission vocabulary (the legacy access model's levels, config-only now). */
export type ResourcePermission = "read" | "write" | "admin";

/**
 * The list row the browser holds: an id, the non-secret presentation and
 * addressing fields, and a "has credential" marker — never a secret value.
 * Seeded rows carry `seeded: true` plus the permission the roles grant; stored
 * rows carry their creator-set permission. Either way the UI can withhold
 * edit/delete (seeded: always) and write controls (below `write`).
 */
export interface ResourceConnectionRow {
  id: string;
  name: string;
  type: ResourceType;
  createdAt: string;
  color?: string;
  environment?: string;
  group?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  tenantId?: string;
  clientId?: string;
  vaultName?: string;
  namespace?: string;
  /** Whether the connection carries any credential the server can use. */
  hasCredential: boolean;
  /** Present only on seeded rows. */
  seeded?: true;
  /** The definer's (stored) or roles' (seeded) grant; absent only on an unsaved candidate. */
  permission?: ResourcePermission;
}

/**
 * What a provider can do, read off the provider without connecting — the shape
 * `provider-meta` answers for databases.
 *
 * `operations` is a closed union covering all three families so routes can
 * gate on membership without downcasting to a family interface first.
 */
export type ResourceOperation =
  | "tree"
  | "blob.read"
  | "blob.download"
  | "blob.upload"
  | "blob.delete"
  | "message.browse"
  | "message.publish"
  | "message.purge"
  | "secret.read"
  | "secret.write"
  | "secret.delete"
  // Kafka workbench. Declared by the kafka provider only; the generic
  // message.* set above keeps serving the Resources section.
  | "kafka.inspect"
  | "kafka.topic.write"
  | "kafka.produce"
  | "kafka.group.write"
  // Vault workbench. Which tabs render and which controls appear is read off
  // these flags, never off the type-id.
  | "vault.secrets"
  | "vault.keys"
  | "vault.certificates"
  | "vault.secret.reveal"
  | "vault.secret.write"
  /** Content type, tags, expiry and enabled travel with a secret write. */
  | "vault.secret.metadata"
  | "vault.key.write"
  | "vault.certificate.write"
  | "vault.delete"
  /** Delete is soft: deleted-item views, recover and purge exist. */
  | "vault.soft-delete";

export interface ResourceProviderCapabilities {
  category: ResourceCategory;
  defaultPort: number | null;
  /** Whether the provider's transport can ride an SSH tunnel. Family modules own endpoint parsing, so this is their declaration to make. */
  supportsSshTunnel: boolean;
  operations: readonly ResourceOperation[];
}

/** Entity nouns for the UI, the weight `ProviderLabels` carries for databases. */
export interface ResourceProviderLabels {
  /** What the tree's root children are called: buckets, containers, topics, queues, mounts. */
  containerNoun: string;
  /** What a leaf is called: object, message, secret, key. */
  itemNoun: string;
}

/**
 * One node of a resource tree. Kinds are provider-declared open strings
 * ("bucket", "object", "topic", "secret", ...) with per-family conventions
 * documented in docs/storagebase/resources/<type-id>.md; the tree UI branches
 * on `hasChildren`, never on kind, the same ruling the object tree follows.
 */
export interface ResourceNode {
  /** Stable within the connection: "<parent-id>/<segment>" so a restored tree re-reads. */
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  /** Rendered metadata (size, message count, version, ...). Never credentials. */
  meta?: Record<string, string | number | boolean | null>;
  hasChildren: boolean;
}

/** A bounded list read. `truncated` is a fact about the read, never a guess. */
export interface ResourceNodePage {
  nodes: readonly ResourceNode[];
  truncated: boolean;
}

export interface ResourceHealth {
  status: "healthy" | "degraded" | "error";
  message?: string;
  latencyMs?: number;
}
