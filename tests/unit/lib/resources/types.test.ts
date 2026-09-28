import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CATEGORY_OF,
  RESOURCE_TYPES,
  isManagedResourceConnection,
  isReadOnlyResourceConnection,
  isResourceType,
  type ManagedResourceConnection,
  type ResourceCategory,
  type ResourceConnection,
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

describe("managed resource connections", () => {
  const owned: ResourceConnection = { id: "r1", name: "mine", type: "kafka", createdAt: "2026-01-01T00:00:00.000Z" };
  const managed = (permission: ManagedResourceConnection["permission"]): ManagedResourceConnection => ({
    ...owned,
    id: `m-${permission}`,
    managed: true,
    permission,
  });

  test("a managed connection says so; the viewer's own does not", () => {
    expect(isManagedResourceConnection(owned)).toBe(false);
    expect(isManagedResourceConnection(managed("write"))).toBe(true);
  });

  test("only a managed connection granted read is read-only — an owned one is full", () => {
    expect(isReadOnlyResourceConnection(owned)).toBe(false);
    expect(isReadOnlyResourceConnection(managed("read"))).toBe(true);
    expect(isReadOnlyResourceConnection(managed("write"))).toBe(false);
    expect(isReadOnlyResourceConnection(managed("admin"))).toBe(false);
  });
});
