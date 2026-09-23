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
  | "RESOURCE_OPERATION_UNSUPPORTED"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_INVALID_REQUEST"
  | "RESOURCE_CONFLICT";

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

/** The addressed object does not exist (a deleted key, an uncreated secret). */
export class ResourceNotFoundError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_NOT_FOUND", 404);
    this.name = "ResourceNotFoundError";
  }
}

/**
 * The service refused the request as malformed for ITS rules (a replication
 * factor above the broker count, an unknown topic config) — a caller mistake
 * the route could not have decided from the body's shape alone.
 */
export class ResourceInvalidRequestError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_INVALID_REQUEST", 400);
    this.name = "ResourceInvalidRequestError";
  }
}

/**
 * The request is well-formed but the resource's current state forbids it (a
 * topic that already exists, an offset reset on a group with live members).
 * The sentence says which state and what would make the request legal.
 */
export class ResourceConflictError extends ResourceError {
  constructor(message: string) {
    super(message, "RESOURCE_CONFLICT", 409);
    this.name = "ResourceConflictError";
  }
}
