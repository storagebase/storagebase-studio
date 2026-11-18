import "../../../setup-dom";
import { mockRouterPush } from "../../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "account-menu" }, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("div", { onClick, role: "menuitem" }, children),
}));

import { displayEndpoint, SectionHeader } from "@/components/storagebase/sections/SectionHeader";
import { sectionById } from "@/components/storagebase/sections/sections";
import type { ResourceConnectionRow, SeededResourceConnection } from "@/storagebase/resources/types";

const events: ResourceConnectionRow = {
  id: "k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker://guest:hunter2@mq.example.com:9092",
  environment: "production",
  color: "#ef4444",
  hasCredential: true,
};

const seeded: SeededResourceConnection = {
  ...events,
  id: "seed:shared",
  name: "shared",
  seeded: true,
  permission: "read",
  endpoint: undefined,
  environment: "other",
};

const base = {
  section: sectionById("messaging"),
  user: { role: "user" },
  isAdmin: false,
  onLogout: mock(() => {}),
};

describe("SectionHeader", () => {
  beforeEach(() => {
    base.onLogout.mockClear();
    mockRouterPush.mockClear();
  });
  afterEach(() => cleanup());

  test("names the section's active connection: name, type, environment, endpoint without credentials", () => {
    const onEdit = mock((_c: unknown) => {});
    render(<SectionHeader {...base} connection={events} health={{ status: "healthy" }} onEdit={onEdit} />);
    expect(screen.getByRole("heading", { name: "events" })).toBeDefined();
    expect(screen.getByText("Apache Kafka")).toBeDefined();
    expect(screen.getByText("• production")).toBeDefined();
    expect(screen.getByText("• broker://mq.example.com:9092")).toBeDefined();
    expect(screen.getByTestId("section-header").textContent).not.toContain("hunter2");
    expect(screen.getByTestId("section-status").textContent).toBe("Online");
    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(onEdit).toHaveBeenCalledWith(events);
    expect(screen.queryByTestId("section-managed")).toBeNull();
  });

  test("every status reads as a word, with the server's sentence as its tooltip", () => {
    const { rerender } = render(<SectionHeader {...base} connection={events} health={{ status: "checking" }} />);
    expect(screen.getByTestId("section-status").textContent).toBe("Checking…");
    rerender(<SectionHeader {...base} connection={events} health={{ status: "degraded", message: "slow" }} />);
    expect(screen.getByTestId("section-status").textContent).toBe("Degraded");
    expect(screen.getByTestId("section-status").getAttribute("title")).toBe("slow");
    rerender(<SectionHeader {...base} connection={events} health={{ status: "error", message: "refused" }} />);
    expect(screen.getByTestId("section-status").getAttribute("data-status")).toBe("error");
    expect(screen.getByTestId("section-status").textContent).toBe("Error");
  });

  test("a seeded connection is marked, read-only when granted read, and never editable", () => {
    const onEdit = mock((_c: unknown) => {});
    const { rerender } = render(
      <SectionHeader {...base} connection={seeded} health={{ status: "healthy" }} onEdit={onEdit} />,
    );
    expect(screen.getByTestId("section-managed").textContent).toBe("Managed · read-only");
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
    expect(screen.queryByText(/production|•/)).toBeNull();
    const writable: SeededResourceConnection = { ...seeded, permission: "write" };
    rerender(<SectionHeader {...base} connection={writable} health={null} />);
    expect(screen.getByTestId("section-managed").textContent).toBe("Managed");
    expect(screen.queryByTestId("section-status")).toBeNull();
  });

  test("without a connection it names the section, and offers back only when asked", () => {
    const onBack = mock(() => {});
    const { rerender } = render(<SectionHeader {...base} connection={null} health={null} />);
    expect(screen.getByRole("heading", { name: "Messaging" })).toBeDefined();
    expect(screen.getByText("No connection selected")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Back to connections" })).toBeNull();
    rerender(<SectionHeader {...base} connection={null} health={null} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to connections" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("the account menu logs out, and links the fork's audit page for admins only", () => {
    const { rerender } = render(<SectionHeader {...base} connection={null} health={null} />);
    expect(screen.queryByText("Audit trail")).toBeNull();
    fireEvent.click(screen.getByText("Logout"));
    expect(base.onLogout).toHaveBeenCalledTimes(1);
    rerender(<SectionHeader {...base} isAdmin connection={null} health={null} />);
    fireEvent.click(screen.getByText("Audit trail"));
    expect(mockRouterPush).toHaveBeenCalledWith("/sb-admin/audit");
    rerender(<SectionHeader {...base} user={null} connection={null} health={null} />);
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  test("an environment without a colour falls back to the default hue", () => {
    render(<SectionHeader {...base} connection={{ ...events, color: undefined, endpoint: undefined }} health={null} />);
    expect(screen.getByText("• production").getAttribute("style")).toContain("color");
  });

  test("displayEndpoint strips user-info and leaves everything else alone", () => {
    expect(displayEndpoint("amqp://user:pass@host:5672/v")).toBe("amqp://host:5672/v");
    expect(displayEndpoint("broker1:9092,broker2:9092")).toBe("broker1:9092,broker2:9092");
    expect(displayEndpoint("https://vault.example.com:8200")).toBe("https://vault.example.com:8200");
  });
});
