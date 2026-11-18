import { describe, test, expect } from "bun:test";
import {
  getResourceViewer,
  hasResourceViewer,
  registerResourceViewer,
} from "@/components/storagebase/resources/viewer-registry";

function FakeViewer() {
  return null;
}

describe("viewer registry", () => {
  test("unknown types throw instead of rendering nothing", () => {
    // A missing viewer is a programmer error (a family that forgot its
    // registration): loud here, where a test pins it, rather than an empty
    // dialog in production. hasResourceViewer stays the quiet probe.
    expect(() => getResourceViewer("openbao")).toThrow('No viewer registered for resource type "openbao"');
    expect(hasResourceViewer("openbao")).toBe(false);
  });

  test("families register one viewer per type-id", () => {
    registerResourceViewer("azure-blob", FakeViewer);

    expect(hasResourceViewer("azure-blob")).toBe(true);
    expect(getResourceViewer("azure-blob")).toBe(FakeViewer);
    // Registration is per-id, not per-family.
    expect(hasResourceViewer("kafka")).toBe(false);
  });
});
