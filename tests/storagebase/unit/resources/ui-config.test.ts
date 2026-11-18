import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CATEGORY_LABELS,
  RESOURCE_CONNECTION_FIELD_NAMES,
  RESOURCE_UI_CONFIG,
  RESOURCE_TYPE_ORDER,
  SECRET_RESOURCE_FIELDS,
  getResourceIcon,
  hasSelectableResourceTypes,
  opensWorkbench,
  selectableResourceTypes,
  takesResourceConnectionField,
} from "@/storagebase/resources/ui-config";
import { RESOURCE_TYPES, type ResourceCategory, type ResourceType } from "@/storagebase/resources/types";
import { registeredResourceTypes, registerResourceProviderLoader } from "@/storagebase/resources/registry";

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
    expect(takesResourceConnectionField("hashicorp-vault", "token")).toBe(true);
    expect(takesResourceConnectionField("hashicorp-vault", "region")).toBe(false);
    expect(takesResourceConnectionField("azure-key-vault", "vaultName")).toBe(true);
    expect(takesResourceConnectionField("azure-key-vault", "endpoint")).toBe(false);
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

  test("the secret marking covers every credential field and no addressing fact", () => {
    expect([...SECRET_RESOURCE_FIELDS].sort()).toEqual(
      (
        [
          "accountKey",
          "clientSecret",
          "connectionString",
          "password",
          "sasUrl",
          "secretAccessKey",
          "sessionToken",
          "token",
        ] as const
      )
        .slice()
        .sort(),
    );
    // Identifiers and addresses are not credentials: the access key id, not the
    // secret access key, and never the endpoint the operator already knows.
    for (const notASecret of ["accessKeyId", "tenantId", "clientId", "vaultName", "endpoint", "namespace", "region"]) {
      expect(SECRET_RESOURCE_FIELDS.has(notASecret as never)).toBe(false);
    }
    // The sealing classification and the seed-file vocabulary agree on names.
    expect(RESOURCE_CONNECTION_FIELD_NAMES).toContain("token");
    for (const field of SECRET_RESOURCE_FIELDS) expect(RESOURCE_CONNECTION_FIELD_NAMES).toContain(field);
  });

  test("the workbench set is the kafka and vault families, never the blob tree", () => {
    expect(opensWorkbench("kafka")).toBe(true);
    expect(opensWorkbench("azure-key-vault")).toBe(true);
    expect(opensWorkbench("hashicorp-vault")).toBe(true);
    expect(opensWorkbench("openbao")).toBe(true);
    expect(opensWorkbench("azure-blob")).toBe(false);
  });
});

describe("selectableResourceTypes (registration gate)", () => {
  test("with nothing registered nothing is offered — the fork shows no dead tiles", () => {
    expect(hasSelectableResourceTypes()).toBe(false);
  });

  test("registering a loader surfaces its type, filtered by category", () => {
    registerResourceProviderLoader("kafka", async () => ({ default: class {} as never }));
    expect(hasSelectableResourceTypes()).toBe(true);
    expect(selectableResourceTypes()).toEqual(["kafka"]);
    expect(selectableResourceTypes("messaging")).toEqual(["kafka"]);
    expect(selectableResourceTypes("blob")).toEqual([]);
    expect(selectableResourceTypes("vault")).toEqual([]);

    registerResourceProviderLoader("hashicorp-vault", async () => ({ default: class {} as never }));
    expect(selectableResourceTypes()).toEqual(["kafka", "hashicorp-vault"]);
    expect(selectableResourceTypes("vault")).toEqual(["hashicorp-vault"]);
    // Registration is what the picker reads: two type-ids are registered now.
    expect([...registeredResourceTypes()].sort()).toEqual(["hashicorp-vault", "kafka"]);
  });
});
