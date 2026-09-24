import type { ComponentType } from "react";
import {
  AzureBlobIcon,
  AwsKmsIcon,
  AwsSecretsManagerIcon,
  AzureKeyVaultIcon,
  HashicorpVaultIcon,
  OpenBaoIcon,
  KafkaIcon,
  RabbitmqIcon,
  S3Icon,
  SqsIcon,
} from "@/components/resources/resource-icons";
import { isResourceTypeRegistered } from "@/lib/resources/registry";
import { RESOURCE_CATEGORY_OF, type ResourceCategory, type ResourceType } from "@/lib/resources/types";

/**
 * The resource layer's UI metadata — the parallel of DB_UI_CONFIG, held to the
 * same rules: an exhaustive Record so a new type-id fails typecheck until it is
 * configured, and a DISTINCT colour per type so the picker never shows two
 * engines in the same hue (pinned by tests/unit/lib/resources/ui-config.test.ts).
 *
 * The field list decides which inputs the resource form renders, the same
 * contract `DB_UI_CONFIG.connectionFields` holds for database connections.
 */
export type ResourceConnectionField =
  | "endpoint"
  | "region"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "connectionString"
  | "token"
  | "tenantId"
  | "clientId"
  | "clientSecret"
  | "accountKey"
  | "vaultName"
  | "namespace";

export interface ResourceUIConfig {
  category: ResourceCategory;
  icon: ComponentType<{ className?: string }>;
  /** A tailwind text colour class, distinct per type-id across the whole table. */
  color: string;
  label: string;
  defaultPort: string;
  connectionFields: readonly ResourceConnectionField[];
}

export const RESOURCE_UI_CONFIG: Record<ResourceType, ResourceUIConfig> = {
  s3: {
    category: "blob",
    icon: S3Icon,
    color: "text-hue-orange",
    label: "Amazon S3",
    defaultPort: "443",
    connectionFields: ["region", "accessKeyId", "secretAccessKey", "sessionToken", "endpoint"],
  },
  "azure-blob": {
    category: "blob",
    icon: AzureBlobIcon,
    color: "text-hue-sky",
    label: "Azure Blob Storage",
    defaultPort: "443",
    connectionFields: ["endpoint", "tenantId", "clientId", "clientSecret", "accountKey"],
  },
  kafka: {
    category: "messaging",
    icon: KafkaIcon,
    color: "text-hue-violet",
    label: "Apache Kafka",
    defaultPort: "9092",
    connectionFields: ["endpoint"],
  },
  rabbitmq: {
    category: "messaging",
    icon: RabbitmqIcon,
    color: "text-hue-rose",
    label: "RabbitMQ",
    defaultPort: "5672",
    connectionFields: ["endpoint", "connectionString"],
  },
  sqs: {
    category: "messaging",
    icon: SqsIcon,
    color: "text-hue-pink",
    label: "Amazon SQS",
    defaultPort: "443",
    connectionFields: ["region", "accessKeyId", "secretAccessKey", "sessionToken"],
  },
  "hashicorp-vault": {
    category: "vault",
    icon: HashicorpVaultIcon,
    color: "text-hue-amber",
    label: "HashiCorp Vault",
    defaultPort: "8200",
    connectionFields: ["endpoint", "token", "namespace"],
  },
  openbao: {
    category: "vault",
    icon: OpenBaoIcon,
    color: "text-hue-yellow",
    label: "OpenBao",
    defaultPort: "8200",
    connectionFields: ["endpoint", "token", "namespace"],
  },
  "azure-key-vault": {
    category: "vault",
    icon: AzureKeyVaultIcon,
    color: "text-hue-blue",
    label: "Azure Key Vault",
    defaultPort: "443",
    connectionFields: ["vaultName", "tenantId", "clientId", "clientSecret"],
  },
  "aws-secrets-manager": {
    category: "vault",
    icon: AwsSecretsManagerIcon,
    color: "text-hue-emerald",
    label: "AWS Secrets Manager",
    defaultPort: "443",
    connectionFields: ["region", "accessKeyId", "secretAccessKey", "sessionToken"],
  },
  "aws-kms": {
    category: "vault",
    icon: AwsKmsIcon,
    color: "text-hue-teal",
    label: "AWS KMS",
    defaultPort: "443",
    connectionFields: ["region", "accessKeyId", "secretAccessKey", "sessionToken"],
  },
};

export const RESOURCE_CATEGORY_LABELS: Record<ResourceCategory, string> = {
  blob: "Blob Storage",
  messaging: "Messaging",
  vault: "Key Vaults",
};

/** The picker order: category by category, types in the order the families land. */
export const RESOURCE_TYPE_ORDER: readonly ResourceType[] = [
  "s3",
  "azure-blob",
  "kafka",
  "rabbitmq",
  "sqs",
  "hashicorp-vault",
  "openbao",
  "azure-key-vault",
  "aws-secrets-manager",
  "aws-kms",
];

/**
 * The types the picker offers: a type appears only when its provider module is
 * REGISTERED, so the fork never shows a connectable-looking tile that answers
 * 501. The config table above stays complete for every type-id regardless —
 * registration is a fact about the build, configuration a fact about the id.
 */
export function selectableResourceTypes(category?: ResourceCategory): readonly ResourceType[] {
  return RESOURCE_TYPE_ORDER.filter(
    (type) => isResourceTypeRegistered(type) && (category === undefined || RESOURCE_CATEGORY_OF[type] === category),
  );
}

export function takesResourceConnectionField(type: ResourceType, field: ResourceConnectionField): boolean {
  return RESOURCE_UI_CONFIG[type].connectionFields.includes(field);
}

export function getResourceIcon(type: ResourceType): ComponentType<{ className?: string }> {
  return RESOURCE_UI_CONFIG[type].icon;
}

/** Whether any family has landed yet — drives the picker's category visibility. */
export function hasSelectableResourceTypes(): boolean {
  return RESOURCE_TYPE_ORDER.some((type) => isResourceTypeRegistered(type));
}

/**
 * Resource types that open a full workbench in the main area instead of the
 * sidebar tree + inspector dialog (StorageBase fork: Kafka and the vault family). Their
 * connections list beside the database connections, not under "Resources".
 * A set, not a config field: it is a fact about the shell's routing, and the
 * exhaustive table above stays about the type itself.
 */
const WORKBENCH_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  "kafka",
  "azure-key-vault",
  "hashicorp-vault",
  "openbao",
  "aws-secrets-manager",
  "aws-kms",
]);

export function opensWorkbench(type: ResourceType): boolean {
  return WORKBENCH_RESOURCE_TYPES.has(type);
}
