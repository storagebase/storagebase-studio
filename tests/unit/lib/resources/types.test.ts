import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CATEGORY_OF,
  RESOURCE_TYPES,
  isResourceType,
  type ResourceCategory,
  type ResourceType,
} from "@/lib/resources/types";

describe("resource type set", () => {
  test("the runtime list is exactly the category table's keys, derived and never hand-written", () => {
    expect([...RESOURCE_TYPES].sort()).toEqual(Object.keys(RESOURCE_CATEGORY_OF).sort() as ResourceType[]);
  });

  test("every category is served — the fork's ten type-ids, two blob, three messaging, five vault", () => {
    const counts: Record<ResourceCategory, number> = { blob: 0, messaging: 0, vault: 0 };
    for (const type of RESOURCE_TYPES) counts[RESOURCE_CATEGORY_OF[type]] += 1;
    expect(counts).toEqual({ blob: 2, messaging: 3, vault: 5 });
  });

  test("isResourceType accepts the declared ids and refuses everything else", () => {
    expect(isResourceType("s3")).toBe(true);
    expect(isResourceType("openbao")).toBe(true);
    expect(isResourceType("postgres")).toBe(false);
    expect(isResourceType("minio")).toBe(false); // S3-compatible endpoints ride the s3 id
    expect(isResourceType(42)).toBe(false);
    expect(isResourceType(null)).toBe(false);
    expect(isResourceType("constructor")).toBe(false); // prototype keys are not type-ids
  });
});
