import "../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

import { ResourceConnectionsList } from "@/components/resources/ResourceConnectionsList";
import type { ResourceConnection } from "@/lib/resources/types";

const s3: ResourceConnection = {
  id: "res-1",
  name: "backups",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const kafka: ResourceConnection = {
  id: "res-2",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("ResourceConnectionsList", () => {
  const props = {
    connections: [s3, kafka],
    activeConnection: null as ResourceConnection | null,
    onSelectConnection: mock((_conn: ResourceConnection) => {}),
    onDeleteConnection: mock((_id: string) => {}),
    onEditConnection: mock((_conn: ResourceConnection) => {}),
    onAddConnection: mock(() => {}),
  };

  beforeEach(() => {
    props.onSelectConnection.mockClear();
    props.onDeleteConnection.mockClear();
    props.onEditConnection.mockClear();
    props.onAddConnection.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders one row per connection with its type label", () => {
    render(<ResourceConnectionsList {...props} />);

    const rows = screen.getAllByTestId("resource-connection-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("backups")).toBeDefined();
    expect(within(rows[0]).getByText("Amazon S3")).toBeDefined();
    expect(within(rows[1]).getByText("Apache Kafka")).toBeDefined();
  });

  test("marks the active connection and reports select, edit, delete, add", () => {
    render(<ResourceConnectionsList {...props} activeConnection={kafka} />);

    const rows = screen.getAllByTestId("resource-connection-row");
    expect(rows[0].getAttribute("aria-current")).toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBe("true");

    fireEvent.click(within(rows[0]).getByText("backups"));
    expect(props.onSelectConnection).toHaveBeenCalledTimes(1);
    expect((props.onSelectConnection.mock.calls[0][0] as ResourceConnection).id).toBe("res-1");

    fireEvent.click(within(rows[0]).getByTestId("resource-connection-edit"));
    expect((props.onEditConnection.mock.calls[0][0] as ResourceConnection).id).toBe("res-1");

    fireEvent.click(within(rows[1]).getByTestId("resource-connection-delete"));
    expect(props.onDeleteConnection).toHaveBeenCalledTimes(1);
    expect(props.onDeleteConnection.mock.calls[0][0]).toBe("res-2");

    fireEvent.click(screen.getByTestId("resource-connections-add"));
    expect(props.onAddConnection).toHaveBeenCalledTimes(1);
  });

  test("renders the empty copy when there are no connections", () => {
    render(<ResourceConnectionsList {...props} connections={[]} />);

    expect(screen.getByText("No resource connections yet.")).toBeDefined();
    expect(screen.queryByTestId("resource-connection-row")).toBeNull();
  });
});
