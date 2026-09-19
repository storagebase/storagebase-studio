import { getOrCreateResourceProvider } from "@/lib/resources/factory";
import { asMessagingOperations, type MessagingOperations } from "@/lib/resources/operations";
import { ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import { ResourceRouteError } from "@/lib/api/resource-route";
import type { ResourceOperation } from "@/lib/resources/types";

/**
 * Shared resolution for the messaging family routes — the blob helper's twin:
 * capability gate first, downcast second, so an unsupported operation is a
 * 400 the route decides, never a probed method.
 */
export async function resolveMessagingOperations(
  connection: Parameters<typeof getOrCreateResourceProvider>[0],
  operation: ResourceOperation,
): Promise<MessagingOperations> {
  const provider = await getOrCreateResourceProvider(connection);
  const operations = asMessagingOperations(provider);
  if (!provider.getCapabilities().operations.includes(operation) || operations === null) {
    throw new ResourceOperationUnsupportedError(`This ${connection.type} connection does not support "${operation}"`);
  }
  return operations;
}

export function requireDestination(body: Record<string, unknown>): string {
  const destination = body.destination;
  if (typeof destination !== "string" || destination === "") {
    throw new ResourceRouteError('"destination" must be a non-empty string', 400);
  }
  return destination;
}

export function requireMessageBody(body: Record<string, unknown>): string {
  if (typeof body.body !== "string" || body.body === "") {
    throw new ResourceRouteError('"body" must be a non-empty string', 400);
  }
  return body.body;
}

export function optionalAttributes(body: Record<string, unknown>): Record<string, string> | undefined {
  if (body.attributes === undefined) return undefined;
  if (typeof body.attributes !== "object" || body.attributes === null || Array.isArray(body.attributes)) {
    throw new ResourceRouteError('"attributes" must be a string-to-string map when present', 400);
  }
  for (const [name, value] of Object.entries(body.attributes)) {
    if (typeof value !== "string") {
      throw new ResourceRouteError(`attribute "${name}" must be a string`, 400);
    }
  }
  return body.attributes as Record<string, string>;
}
