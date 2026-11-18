import { getOrCreateResourceProvider } from "../../factory";
import { asVaultOperations, type VaultOperations } from "../../operations";
import { ResourceOperationUnsupportedError, ResourceRouteError } from "../../errors";
import type { ResourceConnection, ResourceOperation } from "../../types";

/**
 * Shared resolution for the generic secret routes (`/api/sb/secret/*`, ported
 * from the old fork's messaging-route helper). The routes are the vault workbench's
 * browse/publish/purge surface: a KV-v2 mount is browsed as nodes, a secret is
 * published by path and purged by path. The provider behind them is therefore a
 * `VaultOperations` provider — capability gate first, downcast second, so an
 * unsupported operation is a 400 the route decides, never a probed method.
 */
export async function resolveSecretOperations(
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

/** The mount/prefix a browse destination names: `mount` or `mount/path/to/folder`. */
export function splitBrowseDestination(destination: string): { mount: string; prefix: string | null } {
  const slash = destination.indexOf("/");
  if (slash === -1) return { mount: destination, prefix: null };
  const prefix = destination.slice(slash + 1).replace(/\/$/, "");
  return { mount: destination.slice(0, slash), prefix: prefix === "" ? null : prefix };
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

/**
 * Extra string fields of a published secret. A field named `value` is refused:
 * the message body already owns that key and a caller must not silently
 * overwrite it.
 */
export function optionalAttributes(body: Record<string, unknown>): Record<string, string> | undefined {
  if (body.attributes === undefined) return undefined;
  if (typeof body.attributes !== "object" || body.attributes === null || Array.isArray(body.attributes)) {
    throw new ResourceRouteError('"attributes" must be a string-to-string map when present', 400);
  }
  for (const [name, value] of Object.entries(body.attributes)) {
    if (name === "value") throw new ResourceRouteError('an attribute may not be named "value"', 400);
    if (typeof value !== "string") {
      throw new ResourceRouteError(`attribute "${name}" must be a string`, 400);
    }
  }
  return body.attributes as Record<string, string>;
}

/**
 * The value a publish writes. Without attributes it is the body verbatim, so
 * the provider's own `{value}`/JSON rule still applies. With attributes it is
 * one JSON object (`{ value: <body>, ...attributes }`), which the provider
 * stores as a structured secret; reading it back answers JSON, as documented.
 */
export function secretValueOf(body: string, attributes?: Record<string, string>): string {
  if (attributes === undefined || Object.keys(attributes).length === 0) return body;
  return JSON.stringify({ value: body, ...attributes });
}
