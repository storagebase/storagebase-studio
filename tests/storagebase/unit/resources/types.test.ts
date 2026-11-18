import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CATEGORY_OF,
  RESOURCE_TYPES,
  isReadOnlyResourceConnection,
  isSeededResourceConnection,
  isResourceType,
  type ResourceCategory,
  type ResourceConnection,
  type ResourceType,
  type SeededResourceConnection,
} from "@/storagebase/resources/types";

describe("resource type set", () => {
  test("the runtime list is exactly the category table's keys, derived and never hand-written", () => {
    expect([...RESOURCE_TYPES].sort()).toEqual(Object.keys(RESOURCE_CATEGORY_OF).sort() as ResourceType[]);
  });

  test("every category is served — the fork's five type-ids, one blob, one messaging, three vaults", () => {
    const counts: Record<ResourceCategory, number> = { blob: 0, messaging: 0, vault: 0 };
    for (const type of RESOURCE_TYPES) counts[RESOURCE_CATEGORY_OF[type]] += 1;
    expect(counts).toEqual({ blob: 1, messaging: 1, vault: 3 });
  });

  test("isResourceType accepts the declared ids and refuses everything else", () => {
    expect(isResourceType("azure-blob")).toBe(true);
    expect(isResourceType("openbao")).toBe(true);
    expect(isResourceType("postgres")).toBe(false);
    expect(isResourceType("s3")).toBe(false); // deferred by D2, so not a type-id yet
    expect(isResourceType(42)).toBe(false);
    expect(isResourceType(null)).toBe(false);
    expect(isResourceType("constructor")).toBe(false); // prototype keys are not type-ids
  });
});

describe("seeded resource connections", () => {
  const owned: ResourceConnection = { id: "res_1", name: "mine", type: "kafka", createdAt: "2026-01-01T00:00:00.000Z" };
  const seeded = (permission: SeededResourceConnection["permission"]): SeededResourceConnection => ({
    ...owned,
    id: `seed:prod-${permission}`,
    seeded: true,
    permission,
  });

  test("a seeded connection says so; the viewer's own stored one does not", () => {
    expect(isSeededResourceConnection(owned)).toBe(false);
    expect(isSeededResourceConnection(seeded("write"))).toBe(true);
  });

  test("only a seeded connection granted read is read-only — a stored one is full", () => {
    expect(isReadOnlyResourceConnection(owned)).toBe(false);
    expect(isReadOnlyResourceConnection(seeded("read"))).toBe(true);
    expect(isReadOnlyResourceConnection(seeded("write"))).toBe(false);
    expect(isReadOnlyResourceConnection(seeded("admin"))).toBe(false);
  });
});
