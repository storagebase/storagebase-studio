import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installKafkaServer, refuse } from "./kafka-server";

import { KafkaMessagesPanel } from "@/components/resources/kafka/KafkaMessagesPanel";

function renderPanel() {
  return render(<KafkaMessagesPanel connection={connection} topic="orders" partitions={[0, 1]} />);
}

describe("KafkaMessagesPanel", () => {
  beforeEach(() => {
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("tails the newest page on open; a row expands to the full, pretty-printed record", async () => {
    const server = installKafkaServer();
    renderPanel();
    expect(screen.getByText("Reading messages…")).toBeDefined();
    await waitFor(() => expect(screen.getAllByTestId("kafka-message-row")).toHaveLength(2));
    expect(server.last("messages")).toEqual({ connection, topic: "orders", seek: { mode: "latest" }, limit: 50 });
    expect(screen.getByText("2 of 2 shown · more messages exist in this range")).toBeDefined();
    expect(screen.getByText("2023-11-14 22:13:20.000")).toBeDefined();

    const [jsonRow, binaryRow] = screen.getAllByTestId("kafka-message-row");
    fireEvent.click(jsonRow);
    const detail = screen.getByTestId("kafka-message-detail");
    expect(detail.textContent).toContain('"total": 9.5');
    expect(detail.textContent).toContain("trace: abc");
    fireEvent.click(jsonRow);
    expect(screen.queryByTestId("kafka-message-detail")).toBeNull();

    fireEvent.click(binaryRow);
    expect(screen.getByTestId("kafka-message-detail").textContent).toContain("value base64 · value cut at 64 KiB");
  });

  test("the filter narrows the fetched page only", async () => {
    installKafkaServer();
    renderPanel();
    await waitFor(() => screen.getAllByTestId("kafka-message-row"));
    fireEvent.change(screen.getByLabelText("Filter messages"), { target: { value: "ORDER-1" } });
    expect(screen.getAllByTestId("kafka-message-row")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Filter messages"), { target: { value: "abc" } });
    expect(screen.getAllByTestId("kafka-message-row")).toHaveLength(1);
  });

  test("reads from an offset, a timestamp or the oldest, on one partition", async () => {
    const server = installKafkaServer();
    renderPanel();
    await waitFor(() => screen.getAllByTestId("kafka-message-row"));

    fireEvent.change(screen.getByLabelText("Partition"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Messages"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "offset" } });
    fireEvent.change(screen.getByLabelText("Offset"), { target: { value: " 12 " } });
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    await waitFor(() => expect(server.count("messages")).toBe(2));
    expect(server.last("messages")).toMatchObject({ seek: { mode: "offset", offset: "12" }, limit: 10, partition: 1 });

    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "timestamp" } });
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByText("Pick a date and time to seek to.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    await waitFor(() => expect(server.count("messages")).toBe(3));
    expect(server.last("messages")?.seek).toEqual({
      mode: "timestamp",
      timestamp: new Date("2026-01-01T00:00").getTime(),
    });

    fireEvent.change(screen.getByLabelText("Seek"), { target: { value: "earliest" } });
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    await waitFor(() => expect(server.count("messages")).toBe(4));
    expect(server.last("messages")?.seek).toEqual({ mode: "earliest" });
  });

  test("an empty range and a refused read both say so", async () => {
    let calls = 0;
    installKafkaServer({
      messages: () => {
        calls += 1;
        return calls === 1
          ? { json: { messages: [], truncated: false } }
          : { status: 404, json: { error: 'Topic "orders" has no partition 9' } };
      },
    });
    renderPanel();
    await waitFor(() => screen.getByText("No messages in this range."));
    expect(screen.getByText("0 of 0 shown")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    await waitFor(() => screen.getByText('Topic "orders" has no partition 9'));
  });

  test("a failed first read shows the sentence and no table", async () => {
    installKafkaServer({ messages: refuse(502, "Kafka read failed") });
    renderPanel();
    await waitFor(() => screen.getByText("Kafka read failed"));
    expect(screen.queryByTestId("kafka-message-row")).toBeNull();
  });

  test("produces with key, headers and partition, and reports where it landed", async () => {
    const server = installKafkaServer();
    renderPanel();
    await waitFor(() => screen.getAllByTestId("kafka-message-row"));
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    fireEvent.change(screen.getByLabelText("Message key"), { target: { value: "k1" } });
    fireEvent.change(screen.getByLabelText("Message value"), { target: { value: "{}" } });
    fireEvent.change(screen.getByLabelText("Target partition"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Message headers"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText('Headers: "bad" is not name=value')).toBeDefined();

    fireEvent.change(screen.getByLabelText("Message headers"), { target: { value: "trace=t1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => screen.getByText("Produced to partition 1 at offset 42."));
    expect(server.last("produce")).toEqual({
      connection,
      topic: "orders",
      value: "{}",
      key: "k1",
      headers: { trace: "t1" },
      partition: 1,
    });

    fireEvent.change(screen.getByLabelText("Message key"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Message headers"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Target partition"), { target: { value: "any" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(server.count("produce")).toBe(2));
    expect(server.last("produce")).toEqual({ connection, topic: "orders", value: "" });
  });

  test("a refused produce shows the server sentence", async () => {
    installKafkaServer({ produce: refuse(404, 'Topic "orders" does not exist') });
    renderPanel();
    await waitFor(() => screen.getAllByTestId("kafka-message-row"));
    fireEvent.click(screen.getByRole("button", { name: "Produce" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => screen.getByText('Topic "orders" does not exist'));
  });
});
