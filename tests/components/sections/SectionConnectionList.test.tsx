import "../../setup-dom";

import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SectionConnectionList } from "@/components/sections/SectionConnectionList";
import type { ManagedResourceConnection, ResourceConnection } from "@/lib/resources/types";

const owned: ResourceConnection = {
  id: "k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker:9092",
};
const managedRead: ManagedResourceConnection = {
  id: "m1",
  name: "shared queue",
  type: "sqs",
  createdAt: "2026-01-01T00:00:00.000Z",
  managed: true,
  permission: "read",
  groupNames: ["Platform", "Support"],
  // A credential that must never reach the row, should one ever arrive.
  secretAccessKey: "never-rendered",
};
const managedWrite: ManagedResourceConnection = { ...managedRead, id: "m2", name: "jobs", permission: "write" };
const managedAdmin: ManagedResourceConnection = {
  ...managedRead,
  id: "m3",
  name: "ops",
  permission: "admin",
  groupNames: undefined,
};

function renderList(overrides: Partial<React.ComponentProps<typeof SectionConnectionList>> = {}) {
  const handlers = {
    onSelect: mock((_c: ResourceConnection) => {}),
    onEdit: mock((_c: ResourceConnection) => {}),
    onDuplicate: mock((_c: ResourceConnection) => {}),
    onDelete: mock((_c: ResourceConnection) => {}),
    onAdd: mock(() => {}),
  };
  render(
    <SectionConnectionList
      connections={[owned, managedRead, managedWrite, managedAdmin]}
      activeId="k1"
      noun="messaging"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

describe("SectionConnectionList", () => {
  afterEach(() => cleanup());

  test("an owned row selects, edits, duplicates and deletes, and marks itself active", () => {
    const handlers = renderList();
    const mine = row("events");
    expect(within(mine).getByText("Apache Kafka")).toBeDefined();
    const select = within(mine).getByRole("button", { name: /^events/ });
    expect(select.getAttribute("aria-current")).toBe("true");
    fireEvent.click(select);
    fireEvent.click(within(mine).getByRole("button", { name: "Edit events" }));
    fireEvent.click(within(mine).getByRole("button", { name: "Duplicate events" }));
    fireEvent.click(within(mine).getByRole("button", { name: "Delete events" }));
    expect(handlers.onSelect).toHaveBeenCalledWith(owned);
    expect(handlers.onEdit).toHaveBeenCalledWith(owned);
    expect(handlers.onDuplicate).toHaveBeenCalledWith(owned);
    expect(handlers.onDelete).toHaveBeenCalledWith(owned);
  });

  test("a managed row is locked: badges, the grant, no edit, duplicate or delete, no credential", () => {
    const handlers = renderList();
    const shared = row("shared queue");
    expect(shared.getAttribute("data-managed")).toBe("true");
    expect(within(shared).getByTestId("managed-badge").textContent).toBe("Managed");
    expect(within(shared).getByTestId("permission-badge").textContent).toBe("read-only");
    expect(within(shared).queryByRole("button", { name: /^(Edit|Duplicate|Delete) / })).toBeNull();
    expect(shared.textContent).not.toContain("never-rendered");
    const select = within(shared).getByRole("button", { name: /^shared queue/ });
    expect(select.getAttribute("title")).toBe("Managed · granted by Platform, Support");
    expect(select.getAttribute("aria-current")).toBeNull();
    fireEvent.click(select);
    expect(handlers.onSelect).toHaveBeenCalledWith(managedRead);

    expect(within(row("jobs")).getByTestId("permission-badge").textContent).toBe("read-write");
    const ops = row("ops");
    expect(within(ops).getByTestId("permission-badge").textContent).toBe("admin");
    expect(within(ops).getByRole("button", { name: /^ops/ }).getAttribute("title")).toBeNull();
  });

  test("an empty section invites the first connection", () => {
    const handlers = renderList({ connections: [], activeId: null });
    expect(screen.getByText("No messaging connections yet.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(handlers.onAdd).toHaveBeenCalledTimes(1);
  });

  test("says when the managed list is loading or could not be read", () => {
    renderList({ managedLoading: true, managedError: "forbidden" });
    expect(screen.getByText("Loading managed connections…")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("Managed connections could not be loaded: forbidden");
  });
});
