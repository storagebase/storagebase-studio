import { describe, test, expect } from "bun:test";
import {
  ResourceConfigError,
  ResourceConnectionError,
  ResourceError,
  ResourceOperationUnsupportedError,
  ResourceProviderUnavailableError,
} from "@/lib/resources/errors";

describe("resource errors", () => {
  test("each refusal carries its sentence, its machine code and its status", () => {
    expect(new ResourceConfigError("bad record")).toMatchObject({
      name: "ResourceConfigError",
      code: "RESOURCE_CONFIG_ERROR",
      statusCode: 400,
    });
    expect(new ResourceConnectionError("refused")).toMatchObject({
      name: "ResourceConnectionError",
      code: "RESOURCE_CONNECTION_ERROR",
      statusCode: 502,
    });
    expect(new ResourceOperationUnsupportedError("no purge on Kafka")).toMatchObject({
      name: "ResourceOperationUnsupportedError",
      code: "RESOURCE_OPERATION_UNSUPPORTED",
      statusCode: 400,
    });
  });

  test("an unavailable type names the type and, when loaders exist, which ids are ready", () => {
    const empty = new ResourceProviderUnavailableError("sqs", []);
    expect(empty).toMatchObject({ code: "RESOURCE_PROVIDER_UNAVAILABLE", statusCode: 501 });
    expect(empty.message).toContain("sqs");

    const partial = new ResourceProviderUnavailableError("sqs", ["s3"]);
    expect(partial.message).toContain("s3");
  });

  test("every refusal is a ResourceError, so the API mapper reaches one arm", () => {
    for (const error of [
      new ResourceConfigError("a"),
      new ResourceConnectionError("b"),
      new ResourceOperationUnsupportedError("c"),
      new ResourceProviderUnavailableError("s3", []),
    ]) {
      expect(error).toBeInstanceOf(ResourceError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
