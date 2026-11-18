import type { ResourceType } from "./types";

/**
 * The resource layer's typed errors (StorageBase fork, ported from the legacy
 * src/lib/resources/errors.ts). The classes exist so the fork's audit trail
 * can name WHY an action failed as a closed reason (@/storagebase/audit/resource
 * maps them) and so the fork's routes answer machine-readable codes; here they
 * are declared once, with the HTTP mapping in ./handle-request.ts's
 * `forkResourceErrorResponse` — never through upstream's `createErrorResponse`,
 * which knows none of these classes.
 *
 * Fork error codes are fork-local `SB_*` strings (P3): none is added to
 * upstream's `ApiErrorCode` union, so an upstream merge can never conflict on
 * one, and a browser can branch on the code without parsing sentences. Codes
 * exist only where a client must branch; sentences are for humans.
 */
export type ResourceErrorCode =
  | "SB_RESOURCE_CONFIG_ERROR"
  | "SB_RESOURCE_CONNECTION_ERROR"
  | "SB_RESOURCE_PROVIDER_UNAVAILABLE"
  | "SB_RESOURCE_OPERATION_UNSUPPORTED"
  | "SB_RESOURCE_NOT_FOUND"
  | "SB_RESOURCE_INVALID_REQUEST"
  | "SB_RESOURCE_CONFLICT"
  /** A seeded connection the caller may use, but not at this route's level. */
  | "SB_RESOURCE_ACCESS_DENIED"
  /** Seeded connections are read-only from the UI: only the seed file changes them. */
  | "SB_RESOURCE_SEED_READONLY"
  /** The fork store is not configured (STORAGE_PROVIDER=local), so nothing can be persisted. */
  | "SB_STORE_UNAVAILABLE";

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
    super(message, "SB_RESOURCE_CONFIG_ERROR", 400);
    this.name = "ResourceConfigError";
  }
}

/** The provider connected but the service refused or was unreachable. */
export class ResourceConnectionError extends ResourceError {
  constructor(message: string) {
    super(message, "SB_RESOURCE_CONNECTION_ERROR", 502);
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
      "SB_RESOURCE_PROVIDER_UNAVAILABLE",
      501,
    );
    this.name = "ResourceProviderUnavailableError";
  }
}

/** The provider declares no such operation (a purge on Kafka, an upload on a read-only vault role). */
export class ResourceOperationUnsupportedError extends ResourceError {
  constructor(message: string) {
    super(message, "SB_RESOURCE_OPERATION_UNSUPPORTED", 400);
    this.name = "ResourceOperationUnsupportedError";
  }
}

/** The addressed object does not exist (a deleted key, an uncreated secret, a connection that is not there for this caller). */
export class ResourceNotFoundError extends ResourceError {
  constructor(message: string) {
    super(message, "SB_RESOURCE_NOT_FOUND", 404);
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
    super(message, "SB_RESOURCE_INVALID_REQUEST", 400);
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
    super(message, "SB_RESOURCE_CONFLICT", 409);
    this.name = "ResourceConflictError";
  }
}

/** A seeded connection whose grant does not cover what this route needs. */
export class ResourceAccessDeniedError extends ResourceError {
  constructor(granted: string, required: string, name: string) {
    super(`Your access to "${name}" is ${granted}; this needs ${required}.`, "SB_RESOURCE_ACCESS_DENIED", 403);
    this.name = "ResourceAccessDeniedError";
  }
}

/** An edit or delete aimed at a seeded connection: only the seed file changes those. */
export class ResourceSeedReadOnlyError extends ResourceError {
  constructor(id: string) {
    super(
      `Connection "${id}" is preconfigured by the resource seed file and cannot be changed from the UI; edit STORAGEBASE_RESOURCE_SEED_PATH instead.`,
      "SB_RESOURCE_SEED_READONLY",
      403,
    );
    this.name = "ResourceSeedReadOnlyError";
  }
}

/**
 * The fork store is not configured (STORAGE_PROVIDER=local): resource
 * connections cannot be persisted, and the routes say so rather than
 * pretending a write landed.
 */
export class ResourceStoreUnavailableError extends ResourceError {
  constructor() {
    super(
      "Server storage is not enabled, so resource connections cannot be saved. Set STORAGE_PROVIDER to sqlite or postgres and restart the server.",
      "SB_STORE_UNAVAILABLE",
      503,
    );
    this.name = "ResourceStoreUnavailableError";
  }
}

/**
 * A refusal a fork resource route decides for itself, before any provider is
 * built: a caller mistake the route reads off the body (400 by default). Kept
 * parallel to upstream's `ObjectRouteError` rather than importing it, so the
 * fork's status vocabulary lives in the fork's files — and kept OUTSIDE
 * `ResourceError` so the audit reason mapper can tell "the route refused this"
 * from "the provider failed".
 */
export class ResourceRouteError extends Error {
  public readonly status: number;
  public readonly code: ResourceErrorCode;

  constructor(message: string, status = 400, code: ResourceErrorCode = "SB_RESOURCE_INVALID_REQUEST") {
    super(message);
    this.name = "ResourceRouteError";
    this.status = status;
    this.code = code;
  }
}
