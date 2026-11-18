import { getOrCreateResourceProvider } from "../../factory";
import { asVaultOperations, type VaultOperations } from "../../operations";
import { ResourceOperationUnsupportedError, ResourceRouteError } from "../../errors";
import type { ResourceConnection, ResourceOperation } from "../../types";

/**
 * Shared resolution for the vault family routes under /api/sb/vault (ported
 * from the old fork's src/lib/api/resource-vault.ts): capability gate first,
 * downcast second. The generic secret routes (secret/read, secret/write,
 * secret/delete) resolve here; the workbench routes resolve through
 * ./resource-vault-workbench.ts.
 */
export async function resolveVaultOperations(
  connection: ResourceConnection,
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
