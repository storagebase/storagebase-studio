import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, defaultHandlers, installKafkaServer, refuse } from "./kafka-server";

import { KafkaTopicsPanel } from "@/components/resources/kafka/KafkaTopicsPanel";
import { KafkaTopicDetail } from "@/components/resources/kafka/KafkaTopicDetail";

describe("KafkaTopicsPanel", () => {
  const onOpenTopic = mock((_topic: string) => {});

  beforeEach(() => {
    onOpenTopic.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("hides internal topics until asked, filters by name, opens a topic", async () => {
    installKafkaServer();
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row")).toHaveLength(2));
    expect(screen.queryByText("__consumer_offsets")).toBeNull();
    expect(screen.getByText("—")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Show internal topics"));
    expect(screen.getAllByTestId("kafka-topic-row")).toHaveLength(3);
    expect(screen.getByText("internal")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Filter topics"), { target: { value: "PAY" } });
    expect(screen.getAllByTestId("kafka-topic-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "payments" }));
    expect(onOpenTopic).toHaveBeenCalledWith("payments");

    fireEvent.change(screen.getByLabelText("Filter topics"), { target: { value: "nothing" } });
    expect(screen.getByText("No topics match.")).toBeDefined();
  });

  test("says when counts stopped at the bound, and refreshes", async () => {
    const server = installKafkaServer({
      topics: () => ({ json: { topics: [], countsTruncated: true } }),
    });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getByText("Message counts are measured for the first 200 topics only."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("topics")).toBe(2));
  });

  test("creates a topic with configs, then re-lists", async () => {
    const server = installKafkaServer();
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getAllByTestId("kafka-topic-row"));
    fireEvent.click(screen.getByRole("button", { name: "Create topic" }));
    fireEvent.change(screen.getByLabelText("Topic name"), { target: { value: " audit " } });
    fireEvent.change(screen.getByLabelText("Partitions"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Replication factor"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Configs (name=value per line, optional)"), {
      target: { value: "retention.ms = 5\n\ncleanup.policy=compact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => screen.getByText("Created topic audit."));
    expect(server.last("topic/create")).toMatchObject({
      topic: "audit",
      partitions: 3,
      replicationFactor: 2,
      configs: { "retention.ms": "5", "cleanup.policy": "compact" },
    });
    expect(server.count("topics")).toBe(2);
    expect(screen.queryByTestId("kafka-create-topic")).toBeNull();
  });

  test("a malformed config line and a broker refusal both surface without closing the form", async () => {
    installKafkaServer({ "topic/create": refuse(400, "Replication factor: 3 larger than available brokers: 1") });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getAllByTestId("kafka-topic-row"));
    fireEvent.click(screen.getByRole("button", { name: "Create topic" }));
    fireEvent.change(screen.getByLabelText("Topic name"), { target: { value: "audit" } });
    fireEvent.change(screen.getByLabelText("Configs (name=value per line, optional)"), {
      target: { value: "no-equals" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText('Configs: "no-equals" is not name=value')).toBeDefined();

    fireEvent.change(screen.getByLabelText("Configs (name=value per line, optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => screen.getByText("Replication factor: 3 larger than available brokers: 1"));
    expect(screen.getByTestId("kafka-create-topic")).toBeDefined();
  });

  test("a failed listing shows the server sentence", async () => {
    installKafkaServer({ topics: refuse(502, "Kafka list topics failed: timeout") });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getByText("Kafka list topics failed: timeout"));
  });
});

describe("KafkaTopicDetail", () => {
  const onBack = mock(() => {});
  const onDeleted = mock(() => {});

  beforeEach(() => {
    onBack.mockClear();
    onDeleted.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  function renderDetail(topic = "orders") {
    return render(<KafkaTopicDetail connection={connection} topic={topic} onBack={onBack} onDeleted={onDeleted} />);
  }

  test("partitions show leader, replicas, ISR and offsets; partitions are added upward", async () => {
    const server = installKafkaServer();
    renderDetail();
    await waitFor(() => screen.getByTestId("kafka-messages"));
    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    expect(screen.getAllByTestId("kafka-partition-row")).toHaveLength(2);
    expect((screen.getByLabelText("New partition total") as HTMLInputElement).value).toBe("3");

    fireEvent.change(screen.getByLabelText("New partition total"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add partitions" }));
    await waitFor(() => screen.getByText("Topic now has 5 partitions."));
    expect(server.last("topic/partitions")).toMatchObject({ topic: "orders", count: 5 });
    expect(server.count("topic")).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("topic")).toBe(3));
  });

  test("a refused partition change and a refused delete keep the reader on the topic", async () => {
    installKafkaServer({
      "topic/partitions": refuse(409, "Topic already has 2 partitions"),
      "topic/delete": refuse(502, "Kafka delete topic failed"),
    });
    renderDetail();
    await waitFor(() => screen.getByTestId("kafka-messages"));
    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    fireEvent.click(screen.getByRole("button", { name: "Add partitions" }));
    await waitFor(() => screen.getByText("Topic already has 2 partitions"));

    fireEvent.click(screen.getByRole("button", { name: "Delete topic" }));
    const confirmButton = () => screen.getAllByRole("button", { name: "Delete topic" })[0] as HTMLButtonElement;
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type orders to confirm"), { target: { value: "orders" } });
    fireEvent.click(confirmButton());
    await waitFor(() => screen.getByText("Kafka delete topic failed"));
    expect(onDeleted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Type orders to confirm")).toBeNull();
  });

  test("the configuration tab and the back button", async () => {
    installKafkaServer();
    renderDetail("__consumer_offsets");
    await waitFor(() => screen.getByText("internal"));
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(screen.getByTestId("kafka-topic-config")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Topics" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("a topic that cannot be read says why", async () => {
    installKafkaServer({ topic: refuse(404, 'Topic "gone" does not exist') });
    renderDetail("gone");
    await waitFor(() => screen.getByText('Topic "gone" does not exist'));
    expect(screen.queryByTestId("kafka-messages")).toBeNull();
    expect(defaultHandlers.topic).toBeDefined();
  });
});
