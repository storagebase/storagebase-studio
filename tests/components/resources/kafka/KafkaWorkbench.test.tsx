import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installKafkaServer, refuse } from "./kafka-server";

import { KafkaWorkbench } from "@/components/resources/kafka";

describe("KafkaWorkbench", () => {
  const onClose = mock(() => {});
  const onEditConnection = mock((_c: unknown) => {});

  beforeEach(() => {
    onClose.mockClear();
    onEditConnection.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("opens on the topic list with the connection named in the header", async () => {
    installKafkaServer();
    render(<KafkaWorkbench connection={connection} onClose={onClose} onEditConnection={onEditConnection} />);
    expect(screen.getByText("events")).toBeDefined();
    expect(screen.getByText("localhost:9092")).toBeDefined();
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(onEditConnection).toHaveBeenCalledWith(connection);
    fireEvent.click(screen.getByRole("button", { name: "Close workbench" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("without an edit handler there is no edit button", () => {
    installKafkaServer();
    render(<KafkaWorkbench connection={connection} onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
  });

  test("a topic opens its detail; back and delete both return to the list", async () => {
    const server = installKafkaServer();
    render(<KafkaWorkbench connection={connection} onClose={onClose} />);
    await waitFor(() => screen.getByRole("button", { name: "orders" }));
    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    await waitFor(() => screen.getByTestId("kafka-topic-detail"));
    fireEvent.click(screen.getByRole("button", { name: "Topics" }));
    await waitFor(() => screen.getByTestId("kafka-topics"));

    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    await waitFor(() => screen.getByRole("tab", { name: "Partitions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete topic" }));
    fireEvent.change(screen.getByLabelText("Type orders to confirm"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete topic" }));
    await waitFor(() => screen.getByTestId("kafka-topics"));
    expect(server.last("topic/delete")).toMatchObject({ topic: "orders", confirm: "orders" });
  });

  test("consumer groups open their detail; back and delete both return to the list", async () => {
    const server = installKafkaServer();
    render(<KafkaWorkbench connection={connection} onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Consumer groups" }));
    await waitFor(() => screen.getByRole("button", { name: "archiver" }));
    fireEvent.click(screen.getByRole("button", { name: "archiver" }));
    await waitFor(() => screen.getByTestId("kafka-group-detail"));
    fireEvent.click(screen.getByRole("button", { name: "Consumer groups" }));
    await waitFor(() => screen.getByTestId("kafka-groups"));

    fireEvent.click(screen.getByRole("button", { name: "archiver" }));
    await waitFor(() => screen.getByRole("button", { name: "Delete group" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    fireEvent.change(screen.getByLabelText("Type archiver to confirm"), { target: { value: "archiver" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    await waitFor(() => screen.getByTestId("kafka-groups"));
    expect(server.last("group/delete")).toMatchObject({ groupId: "archiver" });
  });

  test("the broker tab lists brokers with the controller named, and refreshes", async () => {
    const server = installKafkaServer();
    render(<KafkaWorkbench connection={connection} onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Brokers" }));
    await waitFor(() => expect(screen.getAllByTestId("kafka-broker-row")).toHaveLength(2));
    expect(screen.getByText("cluster-abc")).toBeDefined();
    expect(screen.getByText("Controller", { selector: "td" })).toBeDefined();
    expect(screen.getByText("r2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("cluster")).toBe(2));
  });

  test("an unreachable cluster says so in the broker tab", async () => {
    installKafkaServer({ cluster: refuse(502, "Kafka describe cluster failed: ECONNREFUSED") });
    render(<KafkaWorkbench connection={connection} onClose={onClose} />);
    fireEvent.click(screen.getByRole("tab", { name: "Brokers" }));
    await waitFor(() => screen.getByText("Kafka describe cluster failed: ECONNREFUSED"));
    expect(screen.queryByTestId("kafka-broker-row")).toBeNull();
  });
});
