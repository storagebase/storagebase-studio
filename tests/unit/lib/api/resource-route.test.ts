import { describe, test, expect } from "bun:test";
import { ResourceRouteError, isResourceConnection } from "@/lib/api/resource-route";

describe("isResourceConnection", () => {
  test("accepts a well-formed resource connection and refuses everything else", () => {
    expect(isResourceConnection({ id: "a", type: "s3" })).toBe(true);
    expect(isResourceConnection({ id: "a", type: "kafka" })).toBe(true);
    expect(isResourceConnection(undefined)).toBe(false);
    expect(isResourceConnection(null)).toBe(false);
    expect(isResourceConnection("s3")).toBe(false);
    expect(isResourceConnection({ id: "a" })).toBe(false);
    expect(isResourceConnection({ id: "a", type: "postgres" })).toBe(false);
  });
});

describe("ResourceRouteError", () => {
  test("carries a message and a caller-blame status", () => {
    const error = new ResourceRouteError("Empty request body", 400);
    expect(error.message).toBe("Empty request body");
    expect(error.status).toBe(400);
    expect(error.name).toBe("ResourceRouteError");
  });
});
