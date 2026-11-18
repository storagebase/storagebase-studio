import { getOrCreateResourceProvider } from "@/storagebase/resources/factory";
import { asBlobOperations, type BlobOperations } from "@/storagebase/resources/operations";
import { ResourceOperationUnsupportedError } from "@/storagebase/resources/errors";
import { ResourceRouteError } from "@/storagebase/resources/handle-request";
import type { ResourceConnection, ResourceOperation } from "@/storagebase/resources/types";

/**
 * Shared resolution for the blob family routes (fork port of the legacy
 * `resource-blob.ts`, moved by path). The capability gate comes first and
 * the downcast second: an unsupported operation is a 400 the route decides
 * (`RESOURCE_OPERATION_UNSUPPORTED`), never a method probed for — the ruling
 * `operations.ts` states for all three families.
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

/**
 * The upload route's multipart body: the same addressing fields as every
 * other blob route, plus the `file` part the stream is taken from. The
 * body-mode switch (multipart vs JSON) is `handleResourceRequest`'s; the
 * field contract is the blob family's, so it lives here beside the family's
 * other route helpers.
 */
export function requireBlobUpload(body: Record<string, unknown>): { bucket: string; name: string; file: File } {
  const { bucket, name } = requireBlobAddress(body);
  const file = body.file;
  if (!(file instanceof File)) {
    throw new ResourceRouteError('"file" must be a file part', 400);
  }
  return { bucket, name, file };
}
