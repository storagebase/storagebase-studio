import "../../../setup-dom";

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installKafkaServer, refuse, installLayout } from "./kafka-server";
import { clearMeasureCacheForTest } from "@/components/resources/kafka/use-lazy-measure";

import { KafkaGroupsPanel } from "@/components/resources/kafka/KafkaGroupsPanel";
import { KafkaGroupDetail } from "@/components/resources/kafka/KafkaGroupDetail";

// The real virtualizer windows rows off the scroll box's size; give it one.
let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installLayout();
});
afterAll(() => restoreLayout());
beforeEach(() => clearMeasureCacheForTest());

describe("KafkaGroupsPanel", () => {
  const onOpenGroup = mock((_id: string) => {});

  beforeEach(() => {
    onOpenGroup.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  const order = () => screen.getAllByTestId("kafka-group-row").map((row) => row.querySelector("button")?.textContent);
  const header = (name: string) => screen.getByRole("button", { name });
  // A plain poll: a sweep re-renders the table dozens of times, which keeps
  // waitFor's DOM observer re-running its callback instead of settling.
  async function until(done: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  test("kafbat's columns: members, topics, lag, coordinator and a state badge; search, peek toggle, refresh", async () => {
    const server = installKafkaServer();
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-group-row")).toHaveLength(2));
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Group ID",
      "Num of members",
      "Num of topics",
      "Consumer lag",
      "Coordinator",
      "State",
    ]);
    const billing = screen.getAllByTestId("kafka-group-row")[1];
    expect(billing.textContent).toContain("STABLE");
    await waitFor(() => expect(screen.getAllByTestId("kafka-group-row")[1].textContent).toBe("billing2272STABLE"));
    expect(screen.getAllByTestId("kafka-group-row")[0].textContent).toBe("archiver01—1EMPTY");

    fireEvent.click(screen.getByLabelText("Show studio peek groups"));
    expect(screen.getAllByTestId("kafka-group-row")).toHaveLength(3);
    // No coordinator reads as a dash.
    await waitFor(() =>
      expect(screen.getAllByTestId("kafka-group-row")[2].textContent).toBe("storagebase-peek-x000—EMPTY"),
    );

    fireEvent.change(screen.getByLabelText("Search by Consumer Group ID"), { target: { value: "BILL" } });
    await waitFor(() => expect(order()).toEqual(["billing"]));
    fireEvent.click(screen.getByRole("button", { name: "billing" }));
    expect(onOpenGroup).toHaveBeenCalledWith("billing");
    fireEvent.change(screen.getByLabelText("Search by Consumer Group ID"), { target: { value: "zzz" } });
    await waitFor(() => screen.getByText("No consumer groups match."));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("groups")).toBe(2));
  });

  test("lag is measured lazily for the rows on screen; an unreadable one shows a dash with the reason", async () => {
    const server = installKafkaServer();
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => screen.getByTitle("orders: topic offsets unavailable"));
    expect(screen.getByText("7")).toBeDefined();
    // Peek groups are hidden, so they are never asked about.
    expect(server.last("groups/lag")?.groupIds).toEqual(["archiver", "billing"]);
    // Sorting by name, members, coordinator or state never sweeps.
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("states are colored badges and filter by what they mean", async () => {
    const states = ["Stable", "PreparingRebalance", "CompletingRebalance", "AwaitingSync", "Empty", "Dead", ""];
    installKafkaServer({
      groups: () => ({
        json: {
          groups: states.map((state, index) => ({
            groupId: `g-${index}`,
            state,
            protocolType: "consumer",
            protocol: "",
            members: 0,
            coordinator: 1,
            internal: false,
          })),
        },
      }),
    });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-group-row")).toHaveLength(7));
    const badges = () =>
      screen.getAllByTestId("kafka-group-state").map((badge) => [badge.textContent, badge.getAttribute("data-state")]);
    expect(badges()).toEqual([
      ["STABLE", "stable"],
      ["PREPARING_REBALANCE", "rebalancing"],
      ["COMPLETING_REBALANCE", "rebalancing"],
      ["AWAITING_SYNC", "rebalancing"],
      ["EMPTY", "empty"],
      ["DEAD", "dead"],
      ["UNKNOWN", "unknown"],
    ]);
    expect(screen.getAllByTitle("Rebalancing")).toHaveLength(3);
    const filterBy = (value: string) =>
      fireEvent.change(screen.getByLabelText("Filter by state"), { target: { value } });
    filterBy("rebalancing");
    await waitFor(() => expect(order()).toEqual(["g-1", "g-2", "g-3"]));
    filterBy("stable");
    await waitFor(() => expect(order()).toEqual(["g-0"]));
    filterBy("empty");
    await waitFor(() => expect(order()).toEqual(["g-4"]));
    filterBy("dead");
    await waitFor(() => expect(order()).toEqual(["g-5"]));
    filterBy("all");
    await waitFor(() => expect(order()).toHaveLength(7));

    fireEvent.click(header("State"));
    expect(order()).toEqual(["g-3", "g-2", "g-5", "g-4", "g-1", "g-0", "g-6"]);
    fireEvent.click(header("State"));
    expect(order()).toEqual(["g-6", "g-0", "g-1", "g-4", "g-5", "g-2", "g-3"]);
    expect(header("State").closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });

  test("sorting by lag measures EVERY group in bounded batches, with progress, and orders them all", async () => {
    const ids = Array.from({ length: 400 }, (_, index) => `group-${String(index).padStart(3, "0")}`);
    let inFlight = 0;
    let peak = 0;
    const server = installKafkaServer({
      groups: () => ({
        json: {
          groups: ids.map((groupId) => ({
            groupId,
            state: "Stable",
            protocolType: "consumer",
            protocol: "range",
            members: 1,
            coordinator: 1,
            internal: false,
          })),
        },
      }),
      "groups/lag": async (body) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          json: {
            lags: Object.fromEntries(
              (body.groupIds as string[]).map((groupId) => {
                const index = Number(groupId.slice(-3));
                // The biggest lag sits far below the first screenful: group-350.
                return [groupId, { totalLag: index === 350 ? 1_000_000 : index, lagError: null, topics: index % 5 }];
              }),
            ),
          },
        };
      },
    });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(server.count("groups/lag")).toBe(1));
    const onScreen = screen.getAllByTestId("kafka-group-row").length;
    expect(onScreen).toBeLessThan(60);

    fireEvent.click(header("Consumer lag"));
    fireEvent.click(header("Consumer lag"));
    await waitFor(() => screen.getByText(/^Measuring lag \d+\/400…$/));
    await until(() => screen.queryByRole("status") === null);
    expect(order()[0]).toBe("group-350");
    expect(order()[1]).toBe("group-399");

    const batches = server.calls
      .filter((call) => call.route === "groups/lag")
      .map((call) => call.body.groupIds as string[]);
    expect(batches.every((batch) => batch.length <= 25)).toBe(true);
    expect(new Set(batches.flat()).size).toBe(400);
    expect(batches.flat()).toHaveLength(400);
    expect(peak).toBeLessThanOrEqual(2);

    // Topics sort off the same measurements: no further requests.
    fireEvent.click(header("Num of topics"));
    expect(screen.getAllByTestId("kafka-group-row")[0].textContent).toContain("group-000");
    fireEvent.click(header("Num of topics"));
    expect(order()[0]).toBe("group-004");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.count("groups/lag")).toBe(batches.length);
  });

  test("a sweep can be cancelled and resumed; unmeasured groups sort last meanwhile", async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `group-${String(index).padStart(3, "0")}`);
    const server = installKafkaServer({
      groups: () => ({
        json: {
          groups: ids.map((groupId) => ({
            groupId,
            state: "Empty",
            protocolType: "consumer",
            protocol: "",
            members: 0,
            coordinator: null,
            internal: false,
          })),
        },
      }),
      "groups/lag": async (body) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          json: {
            lags: Object.fromEntries(
              (body.groupIds as string[]).map((groupId) => [groupId, { totalLag: 1, lagError: null, topics: 1 }]),
            ),
          },
        };
      },
    });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(server.count("groups/lag")).toBe(1));
    fireEvent.click(header("Num of topics"));
    await waitFor(() => screen.getByText(/^Measuring lag \d+\/300…$/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => screen.getByText(/^Lag measured for \d+\/300 groups; unmeasured groups sort last\.$/));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = server.count("groups/lag");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.count("groups/lag")).toBe(stopped);
    expect(stopped).toBeLessThan(12);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await until(() => screen.queryByRole("status") === null);
    expect(
      new Set(
        server.calls.filter((call) => call.route === "groups/lag").flatMap((call) => call.body.groupIds as string[]),
      ).size,
    ).toBe(300);
  });

  test("sorts by name, members and coordinator, unknowns last; a failed lag request marks its rows", async () => {
    installKafkaServer();
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => screen.getByText("7"));
    fireEvent.click(screen.getByLabelText("Show studio peek groups"));
    expect(order()).toEqual(["archiver", "billing", "storagebase-peek-x"]);
    fireEvent.click(header("Group ID"));
    expect(order()).toEqual(["storagebase-peek-x", "billing", "archiver"]);
    fireEvent.click(header("Num of members"));
    expect(order()).toEqual(["archiver", "storagebase-peek-x", "billing"]);
    fireEvent.click(header("Num of members"));
    expect(order()).toEqual(["billing", "archiver", "storagebase-peek-x"]);
    fireEvent.click(header("Coordinator"));
    expect(order()).toEqual(["archiver", "billing", "storagebase-peek-x"]);
    fireEvent.click(header("Coordinator"));
    expect(order()).toEqual(["billing", "archiver", "storagebase-peek-x"]);
    // archiver's lag is unreadable: last either way.
    fireEvent.click(header("Consumer lag"));
    await waitFor(() => expect(order()).toEqual(["storagebase-peek-x", "billing", "archiver"]));
    fireEvent.click(header("Consumer lag"));
    expect(order()).toEqual(["billing", "storagebase-peek-x", "archiver"]);
    cleanup();

    clearMeasureCacheForTest();
    installKafkaServer({ "groups/lag": refuse(502, "Kafka measure consumer group lag failed") });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(screen.getAllByTitle("Kafka measure consumer group lag failed")).toHaveLength(4));
  });

  test("a failed listing says why", async () => {
    installKafkaServer({ groups: refuse(502, "Kafka list consumer groups failed") });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => screen.getByText("Kafka list consumer groups failed"));
  });
});

describe("KafkaGroupDetail", () => {
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

  function renderDetail(groupId: string) {
    return render(<KafkaGroupDetail connection={connection} groupId={groupId} onBack={onBack} onDeleted={onDeleted} />);
  }

  test("a live group shows members and lag, and both writes are refused up front with the reason", async () => {
    installKafkaServer();
    renderDetail("billing");
    await waitFor(() => expect(screen.getAllByTestId("kafka-member-row")).toHaveLength(2));
    expect(screen.getByText("orders [0, 1]")).toBeDefined();
    expect(screen.getAllByTestId("kafka-offset-row")).toHaveLength(2);
    // An end offset that could not be read is a dash carrying the reason.
    expect(screen.getByTitle("topic offsets unavailable").textContent).toBe("—");
    expect(screen.getByText(/The group is Stable with 2 active member\(s\)/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Reset offsets" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete group" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Consumer groups" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("an Empty group resets to earliest, an offset or a timestamp, then re-reads", async () => {
    const server = installKafkaServer();
    renderDetail("archiver");
    await waitFor(() => screen.getByText("No active members."));
    expect((screen.getByLabelText("Topic") as HTMLInputElement).value).toBe("orders");

    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => screen.getByText("Offsets of archiver on orders reset."));
    expect(server.last("group/reset-offsets")).toMatchObject({
      groupId: "archiver",
      topic: "orders",
      reset: { mode: "earliest" },
    });
    expect(server.count("group")).toBe(2);

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "offset" } });
    fireEvent.change(screen.getByLabelText("Reset offset"), { target: { value: " 7 " } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(server.count("group/reset-offsets")).toBe(2));
    expect(server.last("group/reset-offsets")?.reset).toEqual({ mode: "offset", offset: "7" });

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "timestamp" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    expect(screen.getByText("Pick a date and time to reset to.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Reset timestamp"), { target: { value: "2026-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(server.count("group/reset-offsets")).toBe(3));

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "payments" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "latest" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => expect(server.count("group/reset-offsets")).toBe(4));
    expect(server.last("group/reset-offsets")).toMatchObject({ topic: "payments", reset: { mode: "latest" } });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("group")).toBe(6));
  });

  test("refused writes surface; a group with no offsets says so; an unreadable group says why", async () => {
    installKafkaServer({
      group: (body) => ({
        json: { groupId: body.groupId, state: "Empty", protocolType: "", protocol: "", members: [], offsets: [] },
      }),
      "group/reset-offsets": refuse(409, "group is rebalancing"),
      "group/delete": refuse(409, "NON_EMPTY_GROUP"),
    });
    renderDetail("idle");
    await waitFor(() => screen.getByText("No committed offsets."));
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset offsets" }));
    await waitFor(() => screen.getByText("group is rebalancing"));

    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    fireEvent.change(screen.getByLabelText("Type idle to confirm"), { target: { value: "idle" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete group" })[0]);
    await waitFor(() => screen.getByText("NON_EMPTY_GROUP"));
    expect(onDeleted).not.toHaveBeenCalled();
    cleanup();

    installKafkaServer({ group: refuse(404, 'Consumer group "ghost" does not exist') });
    renderDetail("ghost");
    await waitFor(() => screen.getByText('Consumer group "ghost" does not exist'));
  });
});
