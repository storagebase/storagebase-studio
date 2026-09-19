import { describe, test, expect } from "bun:test";
import {
  getResourceViewer,
  hasResourceViewer,
  registerResourceViewer,
} from "@/components/resources/viewer-registry";

function FakeViewer() {
  return null;
}

describe("viewer registry", () => {
  test("unknown types have no viewer — the shell degrades to the tree", () => {
    expect(hasResourceViewer("sqs")).toBe(false);
    expect(getResourceViewer("sqs")).toBeUndefined();
  });

  test("families register one viewer per type-id", () => {
    registerResourceViewer("s3", FakeViewer);

    expect(hasResourceViewer("s3")).toBe(true);
    expect(getResourceViewer("s3")).toBe(FakeViewer);
    // Registration is per-id, not per-family.
    expect(hasResourceViewer("azure-blob")).toBe(false);
  });
});
