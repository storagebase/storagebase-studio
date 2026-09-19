import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import { asVaultOperations, type VaultOperations } from "@/lib/resources/operations";
import { ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import { ResourceRouteError } from "@/lib/api/resource-route";
import type { ResourceOperation } from "@/lib/resources/types";

/**
 * Shared resolution for the vault family routes — the blob/messaging helpers'
 * twin: capability gate first, downcast second.
 */
export async function resolveVaultOperations(
  connection: Parameters<typeof getOrCreateResourceProvider>[0],
  operation: ResourceOperation,
): Promise<VaultOperations> {
  const provider = await getOrCreateResourceProvider(connection);
  const operations = asVaultOperations(provider);
  if (!provider.getCapabilities().operations.includes(operation) || operations === null) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection does not support "${operation}"`);
  }
  return operations;
}

export function requireSecretPath(body: Record<string, unknown>): string {
  const path = body.path;
  if (typeof path !== "string" || path === "") {
    throw new ResourceRouteError('"path" must be a non-empty string', 400);
  }
  return path;
}
