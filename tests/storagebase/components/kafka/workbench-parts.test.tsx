import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch, mockGlobalFetch } from "../../../helpers/mock-fetch";
import { useKafkaRead } from "@/components/storagebase/resources/kafka/use-kafka-read";
import { postKafka, formatPayload, formatTimestamp } from "@/components/storagebase/resources/kafka/kafka-api";
import type { ResourceConnection } from "@/storagebase/resources/types";

/**
 * The shared workbench primitives the vault workbench consumes
 * (`src/components/storagebase/resources/kafka/`), pinned here until the
 * Kafka workbench's own tests arrive with phase 4: the reload's failure arm
 * (the vault components only exercise the mount read's), `postKafka`'s route
 * door, and the two pure formatters.
 */

const connection: ResourceConnection = {
  id: "res-k",
  name: "cluster",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker:9092",
};

/** The hook's own probe: what it holds, and a button that drives `reload`. */
function Probe({ read }: { read: () => Promise<string> }) {
  const { data, error, reload } = useKafkaRead(read);
  return (
    <div>
      <span data-testid="data">{data ?? "null"}</span>
      <span data-testid="error">{error ?? "null"}</span>
      <button type="button" onClick={() => void reload()}>
        Reload
      </button>
    </div>
  );
}

describe("useKafkaRead", () => {
  beforeEach(() => restoreGlobalFetch());
  afterEach(() => cleanup());

  test("the mount read settles into state, and a failed reload keeps the last data beside the error", async () => {
    let fail = false;
    const read = async () => {
      if (fail) throw new Error("broker gone");
      return "cluster-ok";
    };
    render(<Probe read={read} />);
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("cluster-ok"));
    expect(screen.getByTestId("error").textContent).toBe("null");

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("broker gone"));
    // The last good data stays beside the error, never wiped by the refusal.
    expect(screen.getByTestId("data").textContent).toBe("cluster-ok");
  });
});

describe("kafka-api helpers", () => {
  beforeEach(() => restoreGlobalFetch());
  afterEach(() => cleanup());

  test("postKafka sends the connection plus its payload and answers JSON, or throws the server's sentence", async () => {
    let seen: Record<string, unknown> = {};
    mockGlobalFetch({
      "api/sb/kafka/topic": async (req: Request) => {
        seen = (await req.json()) as Record<string, unknown>;
        return { json: { name: seen.name } };
      },
    });
    const answered = await postKafka<{ name: string }>(connection, "topic", { name: "orders" });
    expect(answered).toEqual({ name: "orders" });
    expect(seen).toMatchObject({ connection, name: "orders" });

    mockGlobalFetch({ "api/sb/kafka/topic": { status: 409, json: { error: "topic is being deleted" } } });
    await expect(postKafka(connection, "topic", { name: "orders" })).rejects.toThrow("topic is being deleted");

    mockGlobalFetch({ "api/sb/kafka/topic": { status: 503, text: "gateway" } });
    await expect(postKafka(connection, "topic", { name: "orders" })).rejects.toThrow("Request failed (503)");
  });

  test("formatPayload pretty-prints objects and arrays, passes other text through", () => {
    expect(formatPayload(null)).toBe("");
    expect(formatPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatPayload(" [1,2] ")).toBe("[\n  1,\n  2\n]");
    expect(formatPayload("not json")).toBe("not json");
    expect(formatPayload("{broken")).toBe("{broken");
  });

  test("formatTimestamp renders epoch milliseconds as a UTC stamp, and passes anything else through", () => {
    expect(formatTimestamp("1767225600000")).toBe("2026-01-01 00:00:00.000");
    expect(formatTimestamp("not-a-number")).toBe("not-a-number");
    expect(formatTimestamp("-5")).toBe("-5");
  });
});
