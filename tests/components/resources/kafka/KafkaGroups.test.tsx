import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installKafkaServer, refuse } from "./kafka-server";

import { KafkaGroupsPanel } from "@/components/resources/kafka/KafkaGroupsPanel";
import { KafkaGroupDetail } from "@/components/resources/kafka/KafkaGroupDetail";

describe("KafkaGroupsPanel", () => {
  const onOpenGroup = mock((_id: string) => {});

  beforeEach(() => {
    onOpenGroup.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists groups with state and lag, peek groups hidden until asked", async () => {
    const server = installKafkaServer();
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => expect(screen.getAllByTestId("kafka-group-row")).toHaveLength(2));
    expect(screen.getByText("consumer / range")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Show studio peek groups"));
    expect(screen.getAllByTestId("kafka-group-row")).toHaveLength(3);
    // No protocol type and no protocol reads as a dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Filter consumer groups"), { target: { value: "BILL" } });
    fireEvent.click(screen.getByRole("button", { name: "billing" }));
    expect(onOpenGroup).toHaveBeenCalledWith("billing");
    fireEvent.change(screen.getByLabelText("Filter consumer groups"), { target: { value: "zzz" } });
    expect(screen.getByText("No consumer groups match.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("groups")).toBe(2));
  });

  test("says when lag stopped at the bound; a failed listing says why", async () => {
    installKafkaServer({ groups: () => ({ json: { groups: [], lagTruncated: true } }) });
    render(<KafkaGroupsPanel connection={connection} onOpenGroup={onOpenGroup} />);
    await waitFor(() => screen.getByText("Lag is measured for the first 50 groups only."));
    cleanup();

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
