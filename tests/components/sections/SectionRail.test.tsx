import "../../setup-dom";
import { resetMockPathname, setMockPathname } from "../../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { SectionRail } from "@/components/sections/SectionRail";
import { SectionShell } from "@/components/sections/SectionShell";

function signIn(role: "admin" | "user") {
  mockGlobalFetch({ "api/auth/me": { json: { user: { role } } } });
}

describe("SectionRail", () => {
  afterEach(() => {
    cleanup();
    resetMockPathname();
    restoreGlobalFetch();
  });

  test("links every section by name, marking the one you are on", async () => {
    signIn("user");
    setMockPathname("/messaging");
    render(<SectionRail />);
    const rail = screen.getByRole("navigation", { name: "Sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Databases",
      "Blob storage",
      "Messaging",
      "Vaults",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/", "/storage", "/messaging", "/vaults"]);
    expect(within(rail).getByRole("link", { name: "Messaging" }).getAttribute("aria-current")).toBe("page");
    expect(within(rail).getByRole("link", { name: "Databases" }).getAttribute("aria-current")).toBeNull();
    // The strip's short labels are visible text below the breakpoint.
    expect(within(rail).getByText("MQ")).toBeDefined();
    // A non-admin never sees Admin, even after the user has loaded.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(within(rail).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  test("admins get Admin at the bottom, and the root path is Databases", async () => {
    signIn("admin");
    render(<SectionRail />);
    const admin = await screen.findByRole("link", { name: "Admin" });
    expect(admin.getAttribute("href")).toBe("/admin");
    expect(screen.getByRole("link", { name: "Databases" }).getAttribute("aria-current")).toBe("page");
  });

  test("the shell puts the rail beside the page", () => {
    signIn("user");
    render(
      <SectionShell>
        <div data-testid="page-body">page</div>
      </SectionShell>,
    );
    expect(screen.getByTestId("section-rail")).toBeDefined();
    expect(screen.getByTestId("section-page").contains(screen.getByTestId("page-body"))).toBe(true);
  });
});
