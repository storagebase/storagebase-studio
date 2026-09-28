import { ResourceError } from "@/lib/resources/errors";

/**
 * The access model's refusals (StorageBase fork). They extend the resource layer's typed error so
 * `createErrorResponse` maps them onto HTTP with their code, on database and resource routes alike,
 * without a new arm in upstream territory.
 *
 * A connection the caller cannot see at all is NOT one of these: it is answered exactly like a
 * connection that does not exist (404), so a non-member learns nothing about it.
 */

/** The caller's grant on a managed connection does not cover this operation. */
export class AccessDeniedError extends ResourceError {
  constructor(message: string) {
    super(message, "ACCESS_DENIED", 403);
    this.name = "AccessDeniedError";
  }
}

/** A read-only grant refused a statement or a route that writes. */
export class AccessReadOnlyError extends ResourceError {
  constructor(message: string) {
    super(message, "ACCESS_READ_ONLY", 403);
    this.name = "AccessReadOnlyError";
  }
}

// Single-line, hoisted: bun's line coverage under-counts a wrapped string's continuation lines.
export const ACCESS_STORE_UNAVAILABLE_MESSAGE =
  "Connection groups and managed connections need server storage: set STORAGE_PROVIDER to sqlite or postgres and restart.";

/** STORAGE_PROVIDER=local: there is no server database to keep groups and managed connections in. */
export class AccessStoreUnavailableError extends ResourceError {
  constructor() {
    super(ACCESS_STORE_UNAVAILABLE_MESSAGE, "ACCESS_STORE_UNAVAILABLE", 409);
    this.name = "AccessStoreUnavailableError";
  }
}
