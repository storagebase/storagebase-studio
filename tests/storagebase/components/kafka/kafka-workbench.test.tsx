import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { KafkaWorkbench } from "@/components/storagebase/resources/kafka";
import type { ResourceConnection } from "@/storagebase/resources/types";

const connection: ResourceConnection = {
  id: "seed:kafka-1",
  name: "cluster",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "b1:9092",
};

const listing = {
  topics: [
    { name: "orders", internal: false, partitions: 2, replicationFactor: 2, underReplicatedPartitions: 1 },
    { name: "__consumer_offsets", internal: true, partitions: 1, replicationFactor: 1, underReplicatedPartitions: 0 },
  ],
};
const detail = {
  name: "orders",
  internal: false,
  offsetsError: null,
  partitions: [
    { partition: 0, leader: 1, replicas: [1], isr: [1], offlineReplicas: [], earliestOffset: "1", latestOffset: "9" },
  ],
  configs: [
    {
      name: "cleanup.policy",
      value: "delete",
      source: "DEFAULT_CONFIG",
      isDefault: true,
      readOnly: false,
      isSensitive: false,
    },
    { name: "password", value: null, source: "TOPIC_CONFIG", isDefault: false, readOnly: false, isSensitive: true },
    {
      name: "message.format.version",
      value: null,
      source: "TOPIC_CONFIG",
      isDefault: false,
      readOnly: false,
      isSensitive: false,
    },
  ],
};
const groups = {
  groups: [
    {
      groupId: "g-1",
      state: "Empty",
      protocolType: "consumer",
      protocol: "range",
      members: 1,
      coordinator: 1,
      internal: false,
    },
  ],
};
const groupDetail = {
  groupId: "g-1",
  state: "Empty",
  protocolType: "consumer",
  protocol: "range",
  members: [],
  offsets: [{ topic: "orders", partition: 0, committedOffset: "2", endOffset: "9", lag: 7, endOffsetError: null }],
};

function installRoutes() {
  mockGlobalFetch({
    "api/sb/kafka/cluster": {
      json: {
        clusterId: "c-1",
        controllerId: 1,
        brokers: [{ nodeId: 1, host: "b1", port: 9092, rack: null, isController: true }],
      },
    },
    "api/sb/kafka/topics/counts": { json: { counts: { orders: { messageCount: 12, countError: null } } } },
    "api/sb/kafka/topic/create": { json: { created: true } },
    "api/sb/kafka/topic/partitions": { json: { partitions: 4 } },
    "api/sb/kafka/topic/config": { json: { altered: ["cleanup.policy"] } },
    "api/sb/kafka/topic/delete": { json: { deleted: true } },
    "api/sb/kafka/topics": { json: listing },
    "api/sb/kafka/topic": { json: detail },
    "api/sb/kafka/messages": {
      json: {
        messages: [
          {
            partition: 0,
            offset: "4",
            timestamp: "1700000000000",
            key: "k",
            value: '{"a":1}',
            keyEncoding: "utf8",
            valueEncoding: "utf8",
            valueTruncated: false,
            valueBytes: 7,
            headers: {},
          },
        ],
        truncated: true,
      },
    },
    "api/sb/kafka/groups/lag": { json: { lags: { "g-1": { totalLag: 7, lagError: null, topics: 1 } } } },
    "api/sb/kafka/groups": { json: groups },
    "api/sb/kafka/group/reset-offsets": { json: { offsets: [] } },
    "api/sb/kafka/group/delete": { json: { deleted: true } },
    "api/sb/kafka/group": { json: groupDetail },
  });
}

describe("Kafka workbench", () => {
  beforeEach(() => restoreGlobalFetch());
  afterEach(() => cleanup());

  test("renders the topic list, filter, counts and the create form", async () => {
    installRoutes();
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    expect(screen.getByText("orders")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Filter topics"), { target: { value: "nomatch" } });
    expect(screen.queryAllByTestId("kafka-topic-row")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Filter topics"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: /Create topic/ }));
    const form = screen.getByTestId("kafka-create-topic");
    expect(form).toBeDefined();
    fireEvent.change(screen.getByLabelText("Topic name"), { target: { value: "new-topic" } });
    fireEvent.change(screen.getByLabelText("Topic configs"), { target: { value: "bad-line" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("bad-line"));

    fireEvent.change(screen.getByLabelText("Topic configs"), { target: { value: "retention.ms=60000" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Created topic new-topic.")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  });

  test("opens a topic, reads messages, alters config and adds partitions", async () => {
    installRoutes();
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("orders"));
    await waitFor(() => expect(screen.getByTestId("kafka-topic-detail")).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("kafka-partition-row")).toBeDefined());

    fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Read messages" }));
    await waitFor(() => expect(screen.getByTestId("kafka-message")).toBeDefined());
    expect(screen.getByText(/Truncated/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Seek mode"), { target: { value: "offset" } });
    fireEvent.change(screen.getByLabelText("Seek argument"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Seek mode"), { target: { value: "timestamp" } });
    fireEvent.change(screen.getByLabelText("Seek argument"), { target: { value: "1700000000000" } });

    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    await waitFor(() => expect(screen.getAllByTestId("kafka-config-row").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Config changes"), { target: { value: "cleanup.policy=compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply config" }));
    await waitFor(() => expect(screen.getByText("Config updated.")).toBeDefined());

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.change(screen.getByLabelText("New partition count"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Add partitions" }));
    await waitFor(() => expect(screen.getByText("Partitions added.")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Delete topic" }));
    fireEvent.change(screen.getByLabelText("Type orders to confirm"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete topic" }));
  });

  test("a seek by offset and by timestamp carries the typed argument to the route", async () => {
    installRoutes();
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("orders"));
    await waitFor(() => expect(screen.getByTestId("kafka-topic-detail")).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: "Messages" }));

    function sentSeeks(): unknown[] {
      return fetchMock.mock.calls
        .filter((call) => String(call[0]).includes("api/sb/kafka/messages"))
        .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}")).seek);
    }

    fireEvent.change(screen.getByLabelText("Seek mode"), { target: { value: "offset" } });
    fireEvent.change(screen.getByLabelText("Seek argument"), { target: { value: " 4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Read messages" }));
    await waitFor(() => expect(sentSeeks()).toContainEqual({ mode: "offset", offset: "4" }));

    fireEvent.change(screen.getByLabelText("Seek mode"), { target: { value: "timestamp" } });
    fireEvent.change(screen.getByLabelText("Seek argument"), { target: { value: "1700000000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Read messages" }));
    await waitFor(() => expect(sentSeeks()).toContainEqual({ mode: "timestamp", timestamp: 1700000000000 }));
  });

  test("the config tab holds its own describing state while the topic read is pending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "api/sb/kafka/topics/counts": { json: { counts: {} } },
      "api/sb/kafka/topics": { json: listing },
      "api/sb/kafka/topic": async () => {
        await gate;
        return { json: detail };
      },
      "api/sb/kafka/messages": { json: { messages: [], truncated: false } },
    });
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("orders"));
    await waitFor(() => expect(screen.getByTestId("kafka-topic-detail")).toBeDefined());

    // The describe request has not answered yet, so the config tab shows the
    // same loading line the overview tab does, not an empty config table.
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(screen.getByText("Describing topic…")).toBeDefined();
    expect(screen.queryAllByTestId("kafka-config-row")).toHaveLength(0);

    release();
    await waitFor(() => expect(screen.getAllByTestId("kafka-config-row").length).toBeGreaterThan(0));
  });

  test("lists consumer groups, opens one, resets offsets and deletes it", async () => {
    installRoutes();
    render(<KafkaWorkbench connection={connection} />);
    fireEvent.click(screen.getByRole("tab", { name: "Consumer groups" }));
    await waitFor(() => expect(screen.getByTestId("kafka-group-row")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByText("g-1"));
    await waitFor(() => expect(screen.getByTestId("kafka-group-detail")).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("kafka-group-offset-row")).toBeDefined());

    fireEvent.change(screen.getByLabelText("Offset reset topic"), { target: { value: "orders" } });
    fireEvent.change(screen.getByLabelText("Reset mode"), { target: { value: "offset" } });
    fireEvent.change(screen.getByLabelText("Reset argument"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(screen.getByText("Offsets reset.")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Reset mode"), { target: { value: "timestamp" } });
    fireEvent.change(screen.getByLabelText("Reset argument"), { target: { value: "1700000000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(screen.getAllByText("Offsets reset.").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    fireEvent.change(screen.getByLabelText("Type g-1 to confirm"), { target: { value: "g-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(screen.getByTestId("kafka-groups")).toBeDefined());
  });

  test("shows brokers and withholds write controls on a read-only workbench", async () => {
    installRoutes();
    render(<KafkaWorkbench connection={connection} readOnly />);
    expect(screen.queryByRole("button", { name: /Create topic/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Brokers" }));
    await waitFor(() => expect(screen.getByTestId("kafka-broker-row")).toBeDefined());
    expect(screen.getByText(/c-1/)).toBeDefined();
  });

  test("shows a route refusal and empty states", async () => {
    mockGlobalFetch({
      "api/sb/kafka/topics": { status: 403, json: { error: "denied" } },
      "api/sb/kafka/groups": { json: { groups: [] } },
      "api/sb/kafka/cluster": { status: 403, json: { error: "denied" } },
    });
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("denied"));
    fireEvent.click(screen.getByRole("tab", { name: "Consumer groups" }));
    await waitFor(() => expect(screen.getByText("No consumer groups.")).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: "Brokers" }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
  });

  test("shows failed writes and failed lazy measurements without losing the data", async () => {
    mockGlobalFetch({
      "api/sb/kafka/topics/counts": { status: 500, json: { error: "counts failed" } },
      "api/sb/kafka/topics": { json: listing },
      "api/sb/kafka/topic/config": { status: 500, json: { error: "denied" } },
      "api/sb/kafka/produce": { status: 500, json: { error: "denied" } },
      "api/sb/kafka/topic": { json: detail },
      "api/sb/kafka/groups/lag": { status: 500, json: { error: "lag failed" } },
      "api/sb/kafka/groups": { json: groups },
      "api/sb/kafka/group/reset-offsets": { status: 500, json: { error: "denied" } },
      "api/sb/kafka/group/delete": { status: 500, json: { error: "denied" } },
      "api/sb/kafka/group": { json: groupDetail },
    });
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByText("orders"));
    await waitFor(() => expect(screen.getByTestId("kafka-topic-detail")).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));
    await waitFor(() => expect(screen.getAllByTestId("kafka-config-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Apply config" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("denied"));

    fireEvent.click(screen.getByRole("tab", { name: "Consumer groups" }));
    await waitFor(() => expect(screen.getByTestId("kafka-group-row")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByText("g-1"));
    await waitFor(() => expect(screen.getByTestId("kafka-group-detail")).toBeDefined());
    fireEvent.change(screen.getByLabelText("Offset reset topic"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    fireEvent.change(screen.getByLabelText("Type g-1 to confirm"), { target: { value: "g-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("denied"));
  });

  test("shows a failed topic creation", async () => {
    mockGlobalFetch({
      "api/sb/kafka/topics": { json: listing },
      "api/sb/kafka/topic/create": { status: 409, json: { error: "topic is being deleted" } },
    });
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Create topic/ }));
    fireEvent.change(screen.getByLabelText("Topic name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("topic is being deleted"));
  });

  test("shows a failed message read beside the seek controls", async () => {
    mockGlobalFetch({
      "api/sb/kafka/topics": { json: listing },
      "api/sb/kafka/topic": { json: detail },
      "api/sb/kafka/messages": { status: 500, json: { error: "broker gone" } },
    });
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("orders"));
    await waitFor(() => expect(screen.getByTestId("kafka-topic-detail")).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Read messages" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("broker gone"));
  });
});
