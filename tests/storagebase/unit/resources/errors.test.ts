import { describe, test, expect } from "bun:test";
import {
  ResourceAccessDeniedError,
  ResourceConfigError,
  ResourceConflictError,
  ResourceConnectionError,
  ResourceError,
  ResourceInvalidRequestError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
  ResourceProviderUnavailableError,
  ResourceRouteError,
  ResourceSeedReadOnlyError,
  ResourceStoreUnavailableError,
} from "@/storagebase/resources/errors";

describe("resource errors", () => {
  test("each refusal carries its sentence, its machine code and its status", () => {
    expect(new ResourceConfigError("bad record")).toMatchObject({
      name: "ResourceConfigError",
      code: "SB_RESOURCE_CONFIG_ERROR",
      statusCode: 400,
    });
    expect(new ResourceConnectionError("refused")).toMatchObject({
      name: "ResourceConnectionError",
      code: "SB_RESOURCE_CONNECTION_ERROR",
      statusCode: 502,
    });
    expect(new ResourceOperationUnsupportedError("no purge on Kafka")).toMatchObject({
      name: "ResourceOperationUnsupportedError",
      code: "SB_RESOURCE_OPERATION_UNSUPPORTED",
      statusCode: 400,
    });
    expect(new ResourceNotFoundError('Object "a" does not exist')).toMatchObject({
      name: "ResourceNotFoundError",
      code: "SB_RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    expect(new ResourceInvalidRequestError("replication factor too high")).toMatchObject({
      name: "ResourceInvalidRequestError",
      code: "SB_RESOURCE_INVALID_REQUEST",
      statusCode: 400,
    });
    expect(new ResourceConflictError("group has live members")).toMatchObject({
      name: "ResourceConflictError",
      code: "SB_RESOURCE_CONFLICT",
      statusCode: 409,
    });
  });

  test("an unavailable type names the type and, when loaders exist, which ids are ready", () => {
    const empty = new ResourceProviderUnavailableError("kafka", []);
    expect(empty).toMatchObject({ code: "SB_RESOURCE_PROVIDER_UNAVAILABLE", statusCode: 501 });
    expect(empty.message).toContain("kafka");

    const partial = new ResourceProviderUnavailableError("kafka", ["azure-blob"]);
    expect(partial.message).toContain("azure-blob");
  });

  test("the fork-only refusals carry their own sentences and codes", () => {
    const denied = new ResourceAccessDeniedError("read", "write", "Prod Vault");
    expect(denied).toMatchObject({ code: "SB_RESOURCE_ACCESS_DENIED", statusCode: 403 });
    expect(denied.message).toContain('"Prod Vault"');

    const seedReadOnly = new ResourceSeedReadOnlyError("seed:prod-vault");
    expect(seedReadOnly).toMatchObject({ code: "SB_RESOURCE_SEED_READONLY", statusCode: 403 });
    expect(seedReadOnly.message).toContain("STORAGEBASE_RESOURCE_SEED_PATH");

    const unavailable = new ResourceStoreUnavailableError();
    expect(unavailable).toMatchObject({ code: "SB_STORE_UNAVAILABLE", statusCode: 503 });
    expect(unavailable.message).toContain("STORAGE_PROVIDER");
  });

  test("a route error defaults to the invalid-request shape and keeps any code it is given", () => {
    const plain = new ResourceRouteError("Empty request body");
    expect(plain).toMatchObject({ status: 400, code: "SB_RESOURCE_INVALID_REQUEST" });
    const notFound = new ResourceRouteError("Connection not found", 404, "SB_RESOURCE_NOT_FOUND");
    expect(notFound.status).toBe(404);
    expect(notFound.code).toBe("SB_RESOURCE_NOT_FOUND");
  });

  test("every refusal is a ResourceError, so the fork's API mapper reaches one arm", () => {
    for (const error of [
      new ResourceConfigError("a"),
      new ResourceConnectionError("b"),
      new ResourceOperationUnsupportedError("c"),
      new ResourceNotFoundError("d"),
      new ResourceInvalidRequestError("e"),
      new ResourceConflictError("f"),
      new ResourceProviderUnavailableError("kafka", []),
      new ResourceAccessDeniedError("read", "write", "g"),
      new ResourceSeedReadOnlyError("seed:h"),
      new ResourceStoreUnavailableError(),
    ]) {
      expect(error).toBeInstanceOf(ResourceError);
      expect(error).toBeInstanceOf(Error);
    }
    // The route error is deliberately OUTSIDE that hierarchy: it is the route's
    // own refusal, not the provider's failure.
    expect(new ResourceRouteError("x")).not.toBeInstanceOf(ResourceError);
  });
});
