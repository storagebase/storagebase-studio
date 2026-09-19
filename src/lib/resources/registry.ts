import type { BaseResourceProvider } from "./base-provider";
import { ResourceProviderUnavailableError } from "./errors";
import type { ResourceConnection, ResourceType } from "./types";

/**
 * A provider constructor behind a lazy import, so a connection is created
 * without loading the SDK its family needs — the same reason
 * `createDatabaseProvider` dynamic-imports every case.
 */
export type ResourceProviderConstructor = new (config: ResourceConnection) => BaseResourceProvider;

export type ResourceProviderLoader = () => Promise<{ default: ResourceProviderConstructor }>;

/**
 * The registry the factory resolves through. Deliberately a table and NOT a
 * switch: the table is `Partial`, so a family lands as one entry in its own
 * pull request without touching this file's other lines, and the UI's type
 * picker reads the same table to decide which types are offered.
 *
 * M1 ships it empty. The entries arrive with the families:
 * s3/azure-blob (M2), kafka/rabbitmq/sqs (M3), the vaults (M4).
 */
const RESOURCE_PROVIDER_LOADERS: Partial<Record<ResourceType, ResourceProviderLoader>> = {};

export function registeredResourceTypes(): readonly ResourceType[] {
  return Object.keys(RESOURCE_PROVIDER_LOADERS) as ResourceType[];
}

export function isResourceTypeRegistered(type: ResourceType): boolean {
  return RESOURCE_PROVIDER_LOADERS[type] !== undefined;
}

export function getResourceProviderLoader(type: ResourceType): ResourceProviderLoader {
  const loader = RESOURCE_PROVIDER_LOADERS[type];
  if (loader === undefined) {
    throw new ResourceProviderUnavailableError(type, registeredResourceTypes());
  }
  return loader;
}

/** The one mutation, for family modules and tests. Exported; the fork owns this file outright. */
export function registerResourceProviderLoader(type: ResourceType, loader: ResourceProviderLoader): void {
  RESOURCE_PROVIDER_LOADERS[type] = loader;
}
