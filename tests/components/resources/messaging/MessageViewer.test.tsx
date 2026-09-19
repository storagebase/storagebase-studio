import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";

import { MessageViewer } from "@/components/resources/messaging/MessageViewer";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const connection: ResourceConnection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "localhost:9092",
};

const topicNode: ResourceNode = {
  id: "topic/fixture-events",
  parentId: null,
  kind: "topic",
  name: "fixture-events",
  hasChildren: false,
};

const exchangeNode: ResourceNode = {
  id: "exchange/fixture.events",
  parentId: null,
  kind: "exchange",
  name: "fixture.events",
  hasChildren: false,
};

function mockRoutes(overrides: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "api/resources/message/browse": {
      json: {
        messages: [
          {
            id: "topic/fixture-events/0/0",
            parentId: "topic/fixture-events",
            kind: "message",
            name: "#0",
            meta: { partition: 0, offset: "0", preview: "hello-1" },
            hasChildren: false,
          },
        ],
        truncated: false,
      },
    },
    "api/resources/message/publish": { json: { published: true } },
    "api/resources/message/purge": { json: { purged: true } },
    ...overrides,
  });
}

describe("MessageViewer", () => {
  const props = {
    connection,
    onChanged: mock(() => {}),
    onClose: mock(() => {}),
  };

  beforeEach(() => {
    props.onChanged.mockClear();
    props.onClose.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("topics browse with peek costs stated, then publish", async () => {
    const fetchMock = mockRoutes();
    render(<MessageViewer {...props} node={topicNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-viewer-message")).toBeDefined();
    });
    expect(screen.getByText("Reading from the beginning, oldest first.")).toBeDefined();
    expect(screen.getByText("hello-1")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Publish a message"), { target: { value: "hello-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    const publishCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("message/publish"));
    const body = JSON.parse((publishCall?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ destination: "topic/fixture-events", body: "hello-new" });
    expect(screen.getByText("Published.")).toBeDefined();
  });

  test("purge is two-click and notifies", async () => {
    mockRoutes();
    render(<MessageViewer {...props} node={topicNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-viewer-message")).toBeDefined();
    });

    const purgeButton = screen.getByTestId("message-viewer-purge");
    fireEvent.click(purgeButton);
    expect(purgeButton.textContent).toContain("Click again to confirm");
    expect(props.onChanged).not.toHaveBeenCalled();

    fireEvent.click(purgeButton);
    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Purged.")).toBeDefined();
  });

  test("a refused purge surfaces the server sentence", async () => {
    mockRoutes({
      "api/resources/message/purge": { json: { message: "Kafka has no purge operation" }, status: 400 },
    });
    render(<MessageViewer {...props} node={topicNode} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-viewer-message")).toBeDefined();
    });

    const purgeButton = screen.getByTestId("message-viewer-purge");
    fireEvent.click(purgeButton);
    fireEvent.click(purgeButton);

    await waitFor(() => {
      expect(screen.getByTestId("message-viewer-error")).toBeDefined();
    });
    expect(screen.getByText("Kafka has no purge operation")).toBeDefined();
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  test("exchanges publish with a routing key and cannot be browsed", async () => {
    const fetchMock = mockRoutes();
    render(<MessageViewer {...props} node={exchangeNode} />);

    expect(
      screen.getByText("Exchanges hold no messages — publish below routes through this exchange instead."),
    ).toBeDefined();
    expect(screen.queryByTestId("message-viewer-message")).toBeNull();
    expect(screen.queryByTestId("message-viewer-purge")).toBeNull();

    fireEvent.change(screen.getByLabelText("Publish a message"), { target: { value: "hello-ex" } });
    fireEvent.change(screen.getByLabelText("Routing key"), { target: { value: "orders.created" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      expect(props.onChanged).toHaveBeenCalledTimes(1);
    });
    const publishCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("message/publish"));
    const body = JSON.parse((publishCall?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      destination: "exchange/fixture.events",
      attributes: { routingKey: "orders.created" },
    });
  });

  test("an empty destination lists nothing", async () => {
    mockRoutes({
      "api/resources/message/browse": { json: { messages: [], truncated: false } },
    });
    render(<MessageViewer {...props} node={topicNode} />);

    await waitFor(() => {
      expect(screen.getByText("No messages.")).toBeDefined();
    });
  });
});
