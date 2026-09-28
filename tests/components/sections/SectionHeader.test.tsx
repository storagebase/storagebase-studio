import "../../setup-dom";
import { mockRouterPush } from "../../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "account-menu" }, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("div", { onClick, role: "menuitem" }, children),
}));

import { SectionHeader, displayEndpoint } from "@/components/sections/SectionHeader";
import { sectionById } from "@/components/sections/sections";
import type { ManagedResourceConnection, ResourceConnection } from "@/lib/resources/types";

const rabbit: ResourceConnection = {
  id: "r1",
  name: "orders",
  type: "rabbitmq",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "amqp://guest:hunter2@mq.example.com:5672/vhost",
  environment: "production",
  color: "#ef4444",
};

const managed: ManagedResourceConnection = {
  ...rabbit,
  id: "m1",
  name: "shared",
  managed: true,
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
    const onEdit = mock((_c: ResourceConnection) => {});
    render(<SectionHeader {...base} connection={rabbit} health={{ status: "healthy" }} onEdit={onEdit} />);
    expect(screen.getByRole("heading", { name: "orders" })).toBeDefined();
    expect(screen.getByText("RabbitMQ")).toBeDefined();
    expect(screen.getByText("• production")).toBeDefined();
    expect(screen.getByText("• amqp://mq.example.com:5672/vhost")).toBeDefined();
    expect(screen.getByTestId("section-header").textContent).not.toContain("hunter2");
    expect(screen.getByTestId("section-status").textContent).toBe("Online");
    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(onEdit).toHaveBeenCalledWith(rabbit);
    expect(screen.queryByTestId("section-managed")).toBeNull();
  });

  test("every status reads as a word, with the server's sentence as its tooltip", () => {
    const { rerender } = render(<SectionHeader {...base} connection={rabbit} health={{ status: "checking" }} />);
    expect(screen.getByTestId("section-status").textContent).toBe("Checking…");
    rerender(<SectionHeader {...base} connection={rabbit} health={{ status: "degraded", message: "slow" }} />);
    expect(screen.getByTestId("section-status").textContent).toBe("Degraded");
    expect(screen.getByTestId("section-status").getAttribute("title")).toBe("slow");
    rerender(<SectionHeader {...base} connection={rabbit} health={{ status: "error", message: "refused" }} />);
    expect(screen.getByTestId("section-status").getAttribute("data-status")).toBe("error");
    expect(screen.getByTestId("section-status").textContent).toBe("Error");
  });

  test("a managed connection is marked, read-only when granted read, and never editable", () => {
    const onEdit = mock((_c: ResourceConnection) => {});
    const { rerender } = render(
      <SectionHeader {...base} connection={managed} health={{ status: "healthy" }} onEdit={onEdit} />,
    );
    expect(screen.getByTestId("section-managed").textContent).toBe("Managed · read-only");
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
    expect(screen.queryByText(/production|•/)).toBeNull();
    const writable: ManagedResourceConnection = { ...managed, permission: "write" };
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

  test("the account menu logs out, and offers the admin dashboard to admins only", () => {
    const { rerender } = render(<SectionHeader {...base} connection={null} health={null} />);
    expect(screen.queryByText("Admin Dashboard")).toBeNull();
    fireEvent.click(screen.getByText("Logout"));
    expect(base.onLogout).toHaveBeenCalledTimes(1);
    rerender(<SectionHeader {...base} isAdmin connection={null} health={null} />);
    fireEvent.click(screen.getByText("Admin Dashboard"));
    expect(mockRouterPush).toHaveBeenCalledWith("/admin");
    rerender(<SectionHeader {...base} user={null} connection={null} health={null} />);
    expect(screen.queryByTestId("account-menu")).toBeNull();
  });

  test("an environment without a colour falls back to the default hue", () => {
    render(<SectionHeader {...base} connection={{ ...rabbit, color: undefined, endpoint: undefined }} health={null} />);
    expect(screen.getByText("• production").getAttribute("style")).toContain("color");
  });

  test("displayEndpoint strips user-info and leaves everything else alone", () => {
    expect(displayEndpoint("amqp://user:pass@host:5672/v")).toBe("amqp://host:5672/v");
    expect(displayEndpoint("broker1:9092,broker2:9092")).toBe("broker1:9092,broker2:9092");
    expect(displayEndpoint("https://vault.example.com:8200")).toBe("https://vault.example.com:8200");
  });
});
