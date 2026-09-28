import { describe, test, expect } from "bun:test";
import { SECTIONS, sectionById, sectionForPathname } from "@/components/sections/sections";
import { RESOURCE_CATEGORY_OF } from "@/lib/resources/types";

describe("sections", () => {
  test("one Databases page plus one page per resource category, each with its own route", () => {
    const categories = new Set(Object.values(RESOURCE_CATEGORY_OF));
    expect(SECTIONS.map((section) => section.id)).toEqual(["databases", ...categories]);
    expect(new Set(SECTIONS.map((section) => section.href)).size).toBe(SECTIONS.length);
    expect(sectionById("vault").href).toBe("/vaults");
    expect(sectionById("blob").label).toBe("Blob storage");
  });

  test("a path belongs to the section whose route it is under; anything else is Databases", () => {
    expect(sectionForPathname("/")).toBe("databases");
    expect(sectionForPathname(null)).toBe("databases");
    expect(sectionForPathname("/storage")).toBe("blob");
    expect(sectionForPathname("/messaging/anything")).toBe("messaging");
    expect(sectionForPathname("/vaults")).toBe("vault");
    // A prefix is not a section: /storagebox is not /storage.
    expect(sectionForPathname("/storagebox")).toBe("databases");
    expect(sectionForPathname("/monitoring")).toBe("databases");
  });
});
