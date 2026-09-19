import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import { asBlobOperations, type BlobOperations } from "@/lib/resources/operations";
import { ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import { ResourceRouteError } from "@/lib/api/resource-route";
import type { ResourceOperation } from "@/lib/resources/types";

/**
 * Shared resolution for the blob family routes. The capability gate comes
 * first and the downcast second: an unsupported operation is a 400 the route
 * decides (`RESOURCE_OPERATION_UNSUPPORTED`), never a method probed for — the
 * ruling `operations.ts` states for all three families.
 */
export async function resolveBlobOperations(
  connection: Parameters<typeof getOrCreateResourceProvider>[0],
  operation: ResourceOperation,
): Promise<BlobOperations> {
  const provider = await getOrCreateResourceProvider(connection);
  const operations = asBlobOperations(provider);
  if (!provider.getCapabilities().operations.includes(operation) || operations === null) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection does not support "${operation}"`);
  }
  return operations;
}

function requireTextField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") {
    throw new ResourceRouteError(`"${field}" must be a non-empty string`, 400);
  }
  return value;
}

/** The addressing every blob route reads: bucket always, name except the upload target's parent. */
export function requireBlobAddress(body: Record<string, unknown>): { bucket: string; name: string } {
  return { bucket: requireTextField(body, "bucket"), name: requireTextField(body, "name") };
}
