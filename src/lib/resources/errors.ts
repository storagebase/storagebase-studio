import type { ResourceType } from "./types";

/**
 * The resource layer's typed errors, mapped onto HTTP by `createErrorResponse`
 * the same way the database layer's are. Codes exist only where a client must
 * branch; sentences are for humans.
 */
export type ResourceErrorCode =
  | "RESOURCE_CONFIG_ERROR"
  | "RESOURCE_CONNECTION_ERROR"
  | "RESOURCE_PROVIDER_UNAVAILABLE"
  | "RESOURCE_OPERATION_UNSUPPORTED";

export class ResourceError extends Error {
  public readonly code: ResourceErrorCode;
  public readonly statusCode: number;

  constructor(message: string, code: ResourceErrorCode, statusCode: number) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** A connection record that cannot be a provider: unknown type, missing required addressing. */
export class ResourceConfigError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_CONFIG_ERROR", 400);
    this.name = "ResourceConfigError";
  }
}

/** The provider connected but the service refused or was unreachable. */
export class ResourceConnectionError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_CONNECTION_ERROR", 502);
    this.name = "ResourceConnectionError";
  }
}

/** The type-id exists in the union but no provider module is registered for it yet. */
export class ResourceProviderUnavailableError extends ResourceError {
  constructor(type: ResourceType, registered: readonly ResourceType[]) {
    super(
      registered.length === 0
        ? `No resource provider module is registered yet; resource providers arrive with the ${type} family`
        : `No resource provider module is registered for "${type}"; the registered types are: ${registered.join(", ")}`,
      "RESOURCE_PROVIDER_UNAVAILABLE",
      501,
    );
    this.name = "ResourceProviderUnavailableError";
  }
}

/** The provider declares no such operation (a purge on Kafka, an upload on a read-only vault role). */
export class ResourceOperationUnsupportedError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_OPERATION_UNSUPPORTED", 400);
    this.name = "ResourceOperationUnsupportedError";
  }
}
