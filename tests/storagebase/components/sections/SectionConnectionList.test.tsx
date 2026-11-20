import "../../../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ResourceConnectionRow } from "@/storagebase/resources/types";
import { SectionConnectionList } from "@/components/storagebase/sections/SectionConnectionList";

const owned: ResourceConnectionRow = {
  id: "k1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker:9092",
  hasCredential: true,
  permission: "write",
};
const seededRead: ResourceConnectionRow = {
  ...owned,
  id: "seed:shared",
  name: "shared queue",
  type: "azure-blob",
  seeded: true,
  permission: "read",
  group: "Platform",
};
const seededWrite: ResourceConnectionRow = { ...seededRead, id: "seed:jobs", name: "jobs", permission: "write" };
const seededAdmin: ResourceConnectionRow = {
  ...seededRead,
  id: "seed:ops",
  name: "ops",
  permission: "admin",
  group: undefined,
};

function renderList(overrides: Partial<React.ComponentProps<typeof SectionConnectionList>> = {}) {
  const handlers = {
    onSelect: mock((_c: unknown) => {}),
    onEdit: mock((_c: unknown) => {}),
    onDuplicate: mock((_c: unknown) => {}),
    onDelete: mock((_c: unknown) => {}),
    onAdd: mock(() => {}),
  };
  render(
    <SectionConnectionList
      connections={[owned, seededRead, seededWrite, seededAdmin]}
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
    // A stored row carries its definer's grant too, so the list shows the same badge a seeded row gets.
    expect(within(mine).getByTestId("permission-badge").textContent).toBe("read-write");
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

  test("a seeded row is locked: badges, the grant, no edit, duplicate or delete, no credential", () => {
    const handlers = renderList();
    const shared = row("shared queue");
    expect(shared.getAttribute("data-managed")).toBe("true");
    expect(within(shared).getByTestId("managed-badge").textContent).toBe("Managed");
    expect(within(shared).getByTestId("permission-badge").textContent).toBe("read-only");
    expect(within(shared).queryByRole("button", { name: /^(Edit|Duplicate|Delete) / })).toBeNull();
    expect(shared.textContent).not.toContain("hunter2");
    const select = within(shared).getByRole("button", { name: /^shared queue/ });
    expect(select.getAttribute("title")).toBe("Managed · granted by Platform");
    expect(select.getAttribute("aria-current")).toBeNull();
    fireEvent.click(select);
    expect(handlers.onSelect).toHaveBeenCalledWith(seededRead);

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

  test("says when the seeded list is loading or could not be read", () => {
    renderList({ managedLoading: true, managedError: "forbidden" });
    expect(screen.getByText("Loading managed connections…")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("Managed connections could not be loaded: forbidden");
  });
});
