import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup, waitFor, renderHook, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection } from "./kafka-server";

import {
  errorText,
  formatPayload,
  formatTimestamp,
  parseKeyValueLines,
  postKafka,
} from "@/components/resources/kafka/kafka-api";
import { useKafkaRead } from "@/components/resources/kafka/use-kafka-read";
import { WorkbenchConnectionRows } from "@/components/resources/WorkbenchConnectionRows";
import { opensWorkbench } from "@/lib/resources/ui-config";

describe("kafka-api helpers", () => {
  beforeEach(() => restoreGlobalFetch());

  test("payloads pretty-print only when they parse as JSON objects or arrays", () => {
    expect(formatPayload(null)).toBe("");
    expect(formatPayload("plain")).toBe("plain");
    expect(formatPayload('[1,{"a":2}]')).toBe('[\n  1,\n  {\n    "a": 2\n  }\n]');
    expect(formatPayload("{not json")).toBe("{not json");
  });

  test("timestamps render as UTC stamps; nonsense passes through", () => {
    expect(formatTimestamp("0")).toBe("1970-01-01 00:00:00.000");
    expect(formatTimestamp("-1")).toBe("-1");
    expect(formatTimestamp("soon")).toBe("soon");
  });

  test("name=value lines parse, and a nameless line is named back", () => {
    expect(parseKeyValueLines("a=1\n b = two=2 \n\n")).toEqual({ a: "1", b: "two=2" });
    expect(parseKeyValueLines("=x")).toBe('"=x" is not name=value');
    expect(errorText("plain")).toBe("plain");
  });

  test("a refusal without a JSON body falls back to the status", async () => {
    mockGlobalFetch({ "api/resources/kafka/cluster": { status: 503, text: "gateway" } });
    await expect(postKafka(connection, "cluster")).rejects.toThrow("Request failed (503)");
  });

  test("a superseded read is dropped; a failed reload keeps the last good data", async () => {
    let fail = false;
    const read = mock(async () => {
      if (fail) throw new Error("gone");
      return 1;
    });
    const { result, unmount } = renderHook(() => useKafkaRead(read));
    await waitFor(() => expect(result.current.data).toBe(1));
    fail = true;
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ data: 1, error: "gone" });
    unmount();

    // Unmounted before either answer lands: neither writes state.
    let resolveOk: (value: number) => void = () => {};
    let rejectBad: (error: Error) => void = () => {};
    const pendingOk = renderHook(() => useKafkaRead(() => new Promise<number>((resolve) => (resolveOk = resolve))));
    pendingOk.unmount();
    resolveOk(2);
    const pendingBad = renderHook(() => useKafkaRead(() => new Promise<number>((_, reject) => (rejectBad = reject))));
    pendingBad.unmount();
    rejectBad(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingOk.result.current.data).toBeNull();
    expect(pendingBad.result.current.error).toBeNull();
  });

  test("only kafka opens a workbench", () => {
    expect(opensWorkbench("kafka")).toBe(true);
    expect(opensWorkbench("rabbitmq")).toBe(false);
  });
});

describe("WorkbenchConnectionRows", () => {
  afterEach(() => cleanup());

  test("selects, edits and deletes, marking the active row", () => {
    const onSelect = mock((_c: unknown) => {});
    const onEdit = mock((_c: unknown) => {});
    const onDelete = mock((_id: string) => {});
    render(
      <WorkbenchConnectionRows
        connections={[connection]}
        activeConnection={connection}
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId("workbench-connection-row").getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByText("events"));
    fireEvent.click(screen.getByRole("button", { name: "Edit events" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete events" }));
    expect(onSelect).toHaveBeenCalledWith(connection);
    expect(onEdit).toHaveBeenCalledWith(connection);
    expect(onDelete).toHaveBeenCalledWith("res-k");
  });

  test("without an edit handler, and inactive", () => {
    render(
      <WorkbenchConnectionRows
        connections={[connection]}
        activeConnection={null}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId("workbench-connection-row").getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit events" })).toBeNull();
  });
});
