import type { SSHTunnelConfig } from "@/lib/types";

/**
 * The fork's resource layer: blob storage, messaging systems and key vaults.
 *
 * This module is upstream-absent by design (see STORAGEBASE.md): nothing under
 * `src/lib/resources/**` exists in `libredb/libredb-studio`, so it can never be
 * the cause of a merge conflict. It deliberately does NOT extend `DatabaseType`,
 * `DatabaseConnection` or anything else under `src/lib/db/**`; the database
 * layers stay upstream territory.
 *
 * The shape mirrors what works upstream — a strategy provider behind a factory,
 * capabilities and labels read off the provider without a socket, bounded list
 * reads with an explicit truncation flag — at the weight this surface needs, and
 * no heavier.
 */

/** The three resource categories the fork adds. */
export type ResourceCategory = "blob" | "messaging" | "vault";

/**
 * The resource type-id set. This union is the ONLY list (the rule
 * `EXTERNAL_DATABASE_TYPES` follows upstream); STORAGEBASE.md restates it but
 * derives nothing from prose.
 *
 * S3-compatible endpoints (MinIO, Cloudflare R2, DigitalOcean Spaces, ...) are
 * wire relatives of `s3`, not their own ids: they connect through `s3` with an
 * `endpoint` override, the same way Valkey connects through the redis provider.
 * `openbao` is its own id sharing the Vault provider module, the opensearch
 * precedent (one module, two ids) — it is brand-distinct, not merely compatible.
 */
export type ResourceType =
  | "azure-blob"
  | "s3"
  | "kafka"
  | "rabbitmq"
  | "sqs"
  | "azure-key-vault"
  | "aws-kms"
  | "aws-secrets-manager"
  | "hashicorp-vault"
  | "openbao";

/** Which category a type-id belongs to. Exhaustive, so a new id fails typecheck here first. */
export const RESOURCE_CATEGORY_OF: Record<ResourceType, ResourceCategory> = {
  "azure-blob": "blob",
  s3: "blob",
  kafka: "messaging",
  rabbitmq: "messaging",
  sqs: "messaging",
  "azure-key-vault": "vault",
  "aws-kms": "vault",
  "aws-secrets-manager": "vault",
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
 * Addressing is endpoint-shaped rather than host/port-shaped: an Azure account
 * URL, a Vault address, a Kafka bootstrap list, an S3 endpoint override. The
 * per-provider field set is optional properties classified once, in
 * `RESOURCE_CONNECTION_FIELDS` — the same compile-time enforcement
 * `CONNECTION_FIELDS` gives database connections.
 */
export interface ResourceConnection {
  id: string;
  name: string;
  type: ResourceType;
  createdAt: string;
  color?: string;
  environment?: string;
  group?: string;
  /** Azure account URL, Vault/OpenBao address, S3-compatible endpoint override, Kafka bootstrap list. */
  endpoint?: string;
  /** AWS region. Optional for AWS types; ignored elsewhere. */
  region?: string;
  /** AWS access key id. An identifier, not a credential — the secret access key is the secret. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Temporary AWS session token (STS / assumed roles). */
  sessionToken?: string;
  /** A connection string that carries credentials inline (RabbitMQ amqp://...). */
  connectionString?: string;
  /** Vault/OpenBao token, or a bearer token where a service accepts one. */
  token?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /**
   * Storage account key (Azure Blob shared-key auth, and the Azurite emulator
   * which speaks no Entra ID). A credential — sealed at rest. Either this or
   * the Entra triple above; the provider refuses neither silently.
   */
  accountKey?: string;
  /** Azure Key Vault name, when the endpoint is not spelled as a full vault URL. */
  vaultName?: string;
  /** HashiCorp Vault / OpenBao Enterprise namespace. */
  namespace?: string;
  sshTunnel?: SSHTunnelConfig;
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
  | "secret.delete";

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
 * documented in docs/resources/<type-id>.md; the tree UI branches on
 * `hasChildren`, never on kind, the same ruling the object tree follows.
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
