import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, defaultHandlers, installKafkaServer, refuse } from "./kafka-server";
import type { KafkaConfigEntry } from "@/lib/resources/operations";

import { KafkaTopicConfigPanel } from "@/components/resources/kafka/KafkaTopicConfigPanel";

const configs = (defaultHandlers.topic({ topic: "orders" }).json as { configs: KafkaConfigEntry[] }).configs;

describe("KafkaTopicConfigPanel", () => {
  const onChanged = mock(async () => {});

  beforeEach(() => {
    onChanged.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  function renderPanel() {
    return render(
      <KafkaTopicConfigPanel connection={connection} topic="orders" configs={configs} onChanged={onChanged} />,
    );
  }

  test("lists every entry with its source; sensitive values stay hidden, read-only rows offer no edit", () => {
    installKafkaServer();
    renderPanel();
    expect(screen.getAllByTestId("kafka-config-row")).toHaveLength(4);
    expect(screen.getByText("(sensitive)")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit secret.x" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit message.format.version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset cleanup.policy" })).toBeNull();

    fireEvent.click(screen.getByLabelText("Topic overrides only"));
    expect(screen.getAllByTestId("kafka-config-row")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Filter configs"), { target: { value: "RETENTION" } });
    expect(screen.getAllByTestId("kafka-config-row")).toHaveLength(1);
  });

  test("edits in place, cancels, resets an override and adds a new one", async () => {
    const server = installKafkaServer();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit retention.ms" }));
    expect((screen.getByLabelText("Value for retention.ms") as HTMLInputElement).value).toBe("1000");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Value for retention.ms")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit retention.ms" }));
    fireEvent.change(screen.getByLabelText("Value for retention.ms"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => screen.getByText("Set retention.ms."));
    expect(server.last("topic/config")).toMatchObject({ topic: "orders", changes: { "retention.ms": "5000" } });
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reset retention.ms" }));
    await waitFor(() => screen.getByText("Reset retention.ms to its default."));
    expect(server.last("topic/config")).toMatchObject({ changes: { "retention.ms": null } });

    fireEvent.click(screen.getByRole("button", { name: "Edit cleanup.policy" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.change(screen.getByLabelText("New config name"), { target: { value: " segment.ms " } });
    fireEvent.change(screen.getByLabelText("New config value"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    await waitFor(() => screen.getByText("Set segment.ms."));
    expect(server.last("topic/config")).toMatchObject({ changes: { "segment.ms": "10" } });
    await waitFor(() => expect((screen.getByLabelText("New config name") as HTMLInputElement).value).toBe(""));
  });

  test("a refused edit shows the broker sentence", async () => {
    installKafkaServer({ "topic/config": refuse(400, "Unknown topic config name: nope") });
    renderPanel();
    fireEvent.change(screen.getByLabelText("New config name"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));
    await waitFor(() => screen.getByText("Unknown topic config name: nope"));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
