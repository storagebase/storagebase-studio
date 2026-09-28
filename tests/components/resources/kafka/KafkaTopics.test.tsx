import "../../../setup-dom";

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, defaultHandlers, installKafkaServer, refuse, installLayout } from "./kafka-server";
import { clearMeasureCacheForTest } from "@/components/resources/kafka/use-lazy-measure";

import { KafkaTopicsPanel } from "@/components/resources/kafka/KafkaTopicsPanel";
import { KafkaTopicDetail } from "@/components/resources/kafka/KafkaTopicDetail";

// The real virtualizer windows rows off the scroll box's size; give it one.
let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => clearMeasureCacheForTest());

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
    // Counts arrive after the list, for the rows on screen: a shimmer, then the number or a dash.
    expect(screen.getAllByTestId("kafka-measure-pending").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTitle("partition 0 has no leader").textContent).toBe("—"));
    expect(screen.getByText("3")).toBeDefined();

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

  test("refresh re-lists and forgets the cached counts", async () => {
    const server = installKafkaServer();
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => expect(server.count("topics/counts")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("topics")).toBe(2));
    await waitFor(() => expect(server.count("topics/counts")).toBe(2));
  });

  test("counts are cached per connection for the session: a remount asks for nothing", async () => {
    const server = installKafkaServer();
    const first = render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getByText("3"));
    first.unmount();
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => screen.getByText("3"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.count("topics/counts")).toBe(1);
  });

  test("thousands of topics render a window, and only the rows on screen are counted, in bounded batches", async () => {
    const topics = Array.from({ length: 2000 }, (_, index) => ({
      name: `topic-${String(index).padStart(4, "0")}`,
      internal: false,
      partitions: (index % 7) + 1,
      replicationFactor: 1,
      underReplicatedPartitions: 0,
    }));
    const server = installKafkaServer({ topics: () => ({ json: { topics } }) });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-topic-row").length).toBeGreaterThan(0));
    const rendered = screen.getAllByTestId("kafka-topic-row").length;
    expect(rendered).toBeLessThan(60);
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe("2001");
    await waitFor(() => expect(screen.queryAllByTestId("kafka-measure-pending")).toHaveLength(0));
    const asked = server.calls
      .filter((entry) => entry.route === "topics/counts")
      .map((entry) => entry.body.topics as string[]);
    expect(asked.every((batch) => batch.length <= 25)).toBe(true);
    expect(asked.flat()).toHaveLength(rendered);
    expect(asked.flat()).toContain("topic-0000");
    expect(asked.flat()).not.toContain("topic-1999");
  });

  test("sorts by name, partitions and count; unmeasured counts sort last", async () => {
    installKafkaServer({
      "topics/counts": (body) => ({
        json: {
          counts: Object.fromEntries(
            (body.topics as string[]).map((topic) => [
              topic,
              topic === "payments"
                ? { messageCount: null, countError: "unreadable" }
                : { messageCount: 3, countError: null },
            ]),
          ),
        },
      }),
      topics: () => ({
        json: {
          topics: ["alpha", "orders", "payments"].map((name, index) => ({
            name,
            internal: false,
            partitions: [2, 5, 1][index],
            replicationFactor: 1,
            underReplicatedPartitions: 0,
          })),
        },
      }),
    });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    const order = () => screen.getAllByTestId("kafka-topic-row").map((row) => row.querySelector("button")?.textContent);
    await waitFor(() => expect(screen.getByTitle("unreadable")).toBeDefined());
    expect(order()).toEqual(["alpha", "orders", "payments"]);
    const header = (name: string) => screen.getByRole("button", { name });

    fireEvent.click(header("Topic"));
    expect(order()).toEqual(["payments", "orders", "alpha"]);
    expect(header("Topic").closest("th")?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(header("Partitions"));
    expect(order()).toEqual(["payments", "alpha", "orders"]);
    fireEvent.click(header("Partitions"));
    expect(order()).toEqual(["orders", "alpha", "payments"]);

    fireEvent.click(header("Messages (approx.)"));
    expect(order()).toEqual(["alpha", "orders", "payments"]);
    fireEvent.click(header("Messages (approx.)"));
    // Descending still keeps the unknown last: an unreadable count is not a zero.
    expect(order()).toEqual(["alpha", "orders", "payments"]);
    expect(header("Messages (approx.)").closest("th")?.getAttribute("aria-sort")).toBe("descending");
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

  test("a topic whose count could not be read shows a dash with the reason, and the list says how many", async () => {
    installKafkaServer({
      "topics/counts": () => ({
        json: { counts: { orders: { messageCount: null, countError: "Cannot destructure property 'partitions'" } } },
      }),
    });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() =>
      screen.getByText("Message counts could not be read for 2 topic(s) on screen; hover the dash for the reason."),
    );
    expect(screen.getByTitle("Cannot destructure property 'partitions'").textContent).toBe("—");
    // A name the answer left out reads as not measured.
    expect(screen.getByTitle("not measured").textContent).toBe("—");
  });

  test("a failed count request marks its rows with the reason instead of retrying", async () => {
    const server = installKafkaServer({ "topics/counts": refuse(502, "Kafka count topic messages failed: timeout") });
    render(<KafkaTopicsPanel connection={connection} onOpenTopic={onOpenTopic} />);
    await waitFor(() => expect(screen.getAllByTitle("Kafka count topic messages failed: timeout")).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.count("topics/counts")).toBe(1);
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

  test("partitions still show when the offsets could not be read, with the reason", async () => {
    installKafkaServer({
      topic: (body) => ({
        json: {
          name: body.topic,
          internal: false,
          partitions: [
            {
              partition: 0,
              leader: 1,
              replicas: [1],
              isr: [1],
              offlineReplicas: [],
              earliestOffset: null,
              latestOffset: null,
            },
          ],
          configs: [],
          offsetsError: "partition 0 has no leader",
        },
      }),
    });
    renderDetail("topic-broken");
    await waitFor(() => screen.getByTestId("kafka-messages"));
    fireEvent.click(screen.getByRole("tab", { name: "Partitions" }));
    expect(screen.getByText("Offsets could not be read: partition 0 has no leader")).toBeDefined();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  test("a topic that cannot be read says why", async () => {
    installKafkaServer({ topic: refuse(404, 'Topic "gone" does not exist') });
    renderDetail("gone");
    await waitFor(() => screen.getByText('Topic "gone" does not exist'));
    expect(screen.queryByTestId("kafka-messages")).toBeNull();
    expect(defaultHandlers.topic).toBeDefined();
  });
});
