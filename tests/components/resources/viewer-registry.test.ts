import { describe, test, expect } from "bun:test";
import { getResourceViewer, hasResourceViewer, registerResourceViewer } from "@/components/resources/viewer-registry";

function FakeViewer() {
  return null;
}

describe("viewer registry", () => {
  test("unknown types throw instead of rendering nothing", () => {
    // A missing viewer is a programmer error (a family that forgot its
    // registration): loud here, where a test pins it, rather than an empty
    // dialog in production. hasResourceViewer stays the quiet probe.
    expect(() => getResourceViewer("sqs")).toThrow('No viewer registered for resource type "sqs"');
    expect(hasResourceViewer("sqs")).toBe(false);
  });

  test("families register one viewer per type-id", () => {
    registerResourceViewer("s3", FakeViewer);

    expect(hasResourceViewer("s3")).toBe(true);
    expect(getResourceViewer("s3")).toBe(FakeViewer);
    // Registration is per-id, not per-family.
    expect(hasResourceViewer("azure-blob")).toBe(false);
  });
});
