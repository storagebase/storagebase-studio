import { describe, test, expect, beforeEach } from "bun:test";
import {
  RESOURCE_CATEGORY_LABELS,
  RESOURCE_UI_CONFIG,
  RESOURCE_TYPE_ORDER,
  getResourceIcon,
  hasSelectableResourceTypes,
  selectableResourceTypes,
  takesResourceConnectionField,
} from "@/lib/resources/ui-config";
import { RESOURCE_TYPES, type ResourceCategory, type ResourceType } from "@/lib/resources/types";
import { registeredResourceTypes, registerResourceProviderLoader } from "@/lib/resources/registry";

describe("RESOURCE_UI_CONFIG", () => {
  test("covers every resource type exactly — the exhaustive Record rule", () => {
    expect([...RESOURCE_TYPES].sort()).toEqual(Object.keys(RESOURCE_UI_CONFIG).sort() as ResourceType[]);
    expect([...RESOURCE_TYPE_ORDER].sort()).toEqual(Object.keys(RESOURCE_UI_CONFIG).sort() as ResourceType[]);
  });

  test("every colour is distinct, so the picker never shows two types in one hue", () => {
    const colors = Object.values(RESOURCE_UI_CONFIG).map((config) => config.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  test("every label is distinct and every icon is a drawable component", () => {
    const labels = Object.values(RESOURCE_UI_CONFIG).map((config) => config.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const config of Object.values(RESOURCE_UI_CONFIG)) {
      expect(typeof config.icon).toBe("function");
      expect(config.defaultPort).toMatch(/^\d+$/);
    }
  });

  test("takesResourceConnectionField answers from the declared field list", () => {
    expect(takesResourceConnectionField("s3", "region")).toBe(true);
    expect(takesResourceConnectionField("s3", "token")).toBe(false);
    expect(takesResourceConnectionField("hashicorp-vault", "token")).toBe(true);
    expect(takesResourceConnectionField("hashicorp-vault", "region")).toBe(false);
  });

  test("every category has a display label and every type resolves its own icon", () => {
    const categories: Record<ResourceCategory, string> = {
      blob: "Blob Storage",
      messaging: "Messaging",
      vault: "Key Vaults",
    };
    expect(RESOURCE_CATEGORY_LABELS).toEqual(categories);
    for (const type of RESOURCE_TYPES) {
      expect(getResourceIcon(type)).toBe(RESOURCE_UI_CONFIG[type].icon);
    }
  });
});

describe("selectableResourceTypes (registration gate)", () => {
  beforeEach(() => {
    // No unregister seam on purpose: registration is monotonic like the real
    // builds, so this file registers the two ids it reasons about and the
    // empty-state expectations run inside describe blocks that run first.
  });

  test("with nothing registered nothing is offered — the fork shows no dead tiles", () => {
    expect(hasSelectableResourceTypes()).toBe(false);
  });

  test("registering a loader surfaces its type, filtered by category", () => {
    registerResourceProviderLoader("s3", async () => ({ default: class {} as never }));
    expect(hasSelectableResourceTypes()).toBe(true);
    expect(selectableResourceTypes()).toEqual(["s3"]);
    expect(selectableResourceTypes("blob")).toEqual(["s3"]);
    expect(selectableResourceTypes("vault")).toEqual([]);
    expect(selectableResourceTypes("messaging")).toEqual([]);

    registerResourceProviderLoader("hashicorp-vault", async () => ({ default: class {} as never }));
    expect(selectableResourceTypes()).toEqual(["s3", "hashicorp-vault"]);
    expect(selectableResourceTypes("vault")).toEqual(["hashicorp-vault"]);
    // Registration is what the picker reads: two type-ids are registered now.
    expect([...registeredResourceTypes()].sort()).toEqual(["hashicorp-vault", "s3"]);
  });
});
