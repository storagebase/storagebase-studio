import "../../../setup-dom";

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installKafkaServer, refuse, installLayout } from "./kafka-server";
import { clearMeasureCacheForTest } from "@/components/resources/kafka/use-lazy-measure";

import { KafkaWorkbench } from "@/components/resources/kafka";

// The real virtualizer windows rows off the scroll box's size; give it one.
let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => clearMeasureCacheForTest());

describe("KafkaWorkbench", () => {
  beforeEach(() => {
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("opens on the topic list, with the write controls a full connection has", async () => {
    installKafkaServer();
    render(<KafkaWorkbench connection={connection} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row")).toHaveLength(2));
    // The page header names the connection; the workbench carries no header of its own.
    expect(screen.queryByText("localhost:9092")).toBeNull();
    expect(screen.getByRole("button", { name: "Create topic" })).toBeDefined();
  });

  test("read-only withholds every write and keeps every read", async () => {
    const server = installKafkaServer();
    render(<KafkaWorkbench connection={connection} readOnly />);
    await waitFor(() => screen.getByRole("button", { name: "orders" }));
    expect(screen.queryByRole("button", { name: "Create topic" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "orders" }));
    await waitFor(() => screen.getByTestId("kafka-messages"));
    expect(screen.queryByRole("button", { name: "Produce" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    await waitFor(() => screen.getAllByTestId("kafka-partition-row"));
    expect(screen.queryByRole("button", { name: "Add partitions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete topic" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    await waitFor(() => screen.getAllByTestId("kafka-config-row"));
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reset / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add override" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Consumer groups" }));
    await waitFor(() => screen.getByRole("button", { name: "archiver" }));
    fireEvent.click(screen.getByRole("button", { name: "archiver" }));
    await waitFor(() => screen.getAllByTestId("kafka-offset-row"));
    expect(screen.queryByTestId("kafka-reset-offsets")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete group" })).toBeNull();
    expect(server.count("topic/create") + server.count("produce")).toBe(0);
  });

  test("a topic opens its detail; back and delete both return to the list", async () => {
    const server = installKafkaServer();
    render(<KafkaWorkbench connection={connection} />);
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
    render(<KafkaWorkbench connection={connection} />);
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
    render(<KafkaWorkbench connection={connection} />);
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
    render(<KafkaWorkbench connection={connection} />);
    fireEvent.click(screen.getByRole("tab", { name: "Brokers" }));
    await waitFor(() => screen.getByText("Kafka describe cluster failed: ECONNREFUSED"));
    expect(screen.queryByTestId("kafka-broker-row")).toBeNull();
  });
});
