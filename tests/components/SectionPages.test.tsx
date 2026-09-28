import "../setup-dom";
import { mock } from "bun:test";
import React from "react";

// The pages are routing glue: the page component and the shell are tested on their own.
mock.module("@/components/sections/ResourceSectionPage", () => ({
  ResourceSectionPage: (props: { category: string; initialConnectionId: string | null }) =>
    React.createElement("div", {
      "data-testid": "section-page-body",
      "data-category": props.category,
      "data-connection": String(props.initialConnectionId),
    }),
}));
mock.module("@/components/sections/SectionShell", () => ({
  SectionShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "section-shell" }, children),
}));

const storage = await import("@/app/(sections)/storage/page");
const messaging = await import("@/app/(sections)/messaging/page");
const vaults = await import("@/app/(sections)/vaults/page");
const { default: SectionsLayout } = await import("@/app/(sections)/layout");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

type SectionRoute = {
  default: (props: { searchParams: Promise<{ connection?: string | string[] }> }) => Promise<React.ReactElement>;
  metadata: { title?: unknown };
};

describe("section routes", () => {
  afterEach(() => cleanup());

  test.each([
    ["storage", storage as SectionRoute, "blob", "Blob storage | StorageBase Studio"],
    ["messaging", messaging as SectionRoute, "messaging", "Messaging | StorageBase Studio"],
    ["vaults", vaults as SectionRoute, "vault", "Vaults | StorageBase Studio"],
  ])("/%s renders its category's page and names the tab", async (_path, route, category, title) => {
    expect(route.metadata.title).toBe(title);
    render(await route.default({ searchParams: Promise.resolve({}) }));
    const body = screen.getByTestId("section-page-body");
    expect(body.getAttribute("data-category")).toBe(category);
    expect(body.getAttribute("data-connection")).toBe("null");
  });

  test("?connection= is the deep link, the first value when repeated", async () => {
    const page = messaging as SectionRoute;
    render(await page.default({ searchParams: Promise.resolve({ connection: "k1" }) }));
    expect(screen.getByTestId("section-page-body").getAttribute("data-connection")).toBe("k1");
    cleanup();
    render(await page.default({ searchParams: Promise.resolve({ connection: ["k2", "k3"] }) }));
    expect(screen.getByTestId("section-page-body").getAttribute("data-connection")).toBe("k2");
  });

  test("the layout wraps every resource section in the shell", () => {
    render(
      <SectionsLayout>
        <p>child</p>
      </SectionsLayout>,
    );
    expect(screen.getByTestId("section-shell").textContent).toBe("child");
  });
});
