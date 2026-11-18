import type { ComponentType } from "react";
import {
  AzureBlobIcon,
  AzureKeyVaultIcon,
  HashicorpVaultIcon,
  KafkaIcon,
  OpenBaoIcon,
} from "@/components/storagebase/resources/resource-icons";
import { isResourceTypeRegistered } from "@/storagebase/resources/registry";
import { RESOURCE_CATEGORY_OF, type ResourceCategory, type ResourceType } from "@/storagebase/resources/types";

/**
 * The resource layer's UI metadata — the parallel of DB_UI_CONFIG, held to the
 * same rules: an exhaustive Record so a new type-id fails typecheck until it is
 * configured, and a DISTINCT colour per type so the picker never shows two
 * engines in the same hue (pinned by tests/storagebase/unit/resources/ui-config.test.ts).
 *
 * The field list decides which inputs the resource form renders, the same
 * contract `DB_UI_CONFIG.connectionFields` holds for database connections.
 * `SECRET_RESOURCE_FIELDS` is the sealing contract's one source: every field
 * it names is sealed before a record reaches the fork store and is never
 * served back to the browser (the "has credential" marker stands in for it).
 */
export type ResourceConnectionField =
  | "endpoint"
  | "region"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "connectionString"
  | "token"
  | "password"
  | "tenantId"
  | "clientId"
  | "clientSecret"
  | "accountKey"
  | "sasUrl"
  | "authMode"
  | "vaultName"
  | "namespace";

/** The field-name vocabulary as a runtime value, for seed-file validation. */
export const RESOURCE_CONNECTION_FIELD_NAMES: readonly ResourceConnectionField[] = [
  "endpoint",
  "region",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "connectionString",
  "token",
  "password",
  "tenantId",
  "clientId",
  "clientSecret",
  "accountKey",
  "sasUrl",
  "authMode",
  "vaultName",
  "namespace",
];

/**
 * The fields whose value is a credential — the fork's one classification of
 * "secret" for resource connections. `sealing.ts` seals exactly these before a
 * record is stored, list/detail rows never carry them, and the seed file
 * resolves `${env:…}` / `${vault:…}` references in them. `accessKeyId`,
 * `tenantId`, `clientId`, `vaultName`, `endpoint` and `namespace` are
 * addressing facts and identifiers, not credentials — the secret access key,
 * not the access key id.
 */
export const SECRET_RESOURCE_FIELDS: ReadonlySet<ResourceConnectionField> = new Set([
  "clientSecret",
  "token",
  "secretAccessKey",
  "sessionToken",
  "accountKey",
  "connectionString",
  "password",
  "sasUrl",
]);

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
  "azure-blob": {
    category: "blob",
    icon: AzureBlobIcon,
    color: "text-hue-sky",
    label: "Azure Blob Storage",
    defaultPort: "443",
    connectionFields: ["endpoint", "tenantId", "clientId", "clientSecret", "accountKey", "sasUrl", "authMode"],
  },
  kafka: {
    category: "messaging",
    icon: KafkaIcon,
    color: "text-hue-violet",
    label: "Apache Kafka",
    defaultPort: "9092",
    connectionFields: ["endpoint"],
  },
  "azure-key-vault": {
    category: "vault",
    icon: AzureKeyVaultIcon,
    color: "text-hue-blue",
    label: "Azure Key Vault",
    defaultPort: "443",
    connectionFields: ["vaultName", "tenantId", "clientId", "clientSecret"],
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
};

export const RESOURCE_CATEGORY_LABELS: Record<ResourceCategory, string> = {
  blob: "Blob Storage",
  messaging: "Messaging",
  vault: "Key Vaults",
};

/** The picker order: category by category, types in the order the families land. */
export const RESOURCE_TYPE_ORDER: readonly ResourceType[] = [
  "azure-blob",
  "kafka",
  "hashicorp-vault",
  "openbao",
  "azure-key-vault",
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
 * Resource types that open a full-page workbench on their section page
 * instead of a tree with a viewer beside it (StorageBase fork: Kafka and the
 * vault family). A set, not a config field: it is a fact about the pages'
 * routing, and the exhaustive table above stays about the type itself.
 */
const WORKBENCH_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  "kafka",
  "azure-key-vault",
  "hashicorp-vault",
  "openbao",
]);

export function opensWorkbench(type: ResourceType): boolean {
  return WORKBENCH_RESOURCE_TYPES.has(type);
}
