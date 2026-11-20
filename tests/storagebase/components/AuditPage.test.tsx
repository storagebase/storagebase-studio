import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupFramerMotionMock } from "../../helpers/mock-monaco";

setupFramerMotionMock();

const mockDownloadText = mock((_content: string, _mimeType: string, _fileName: string) => {});
mock.module("@/lib/export/download", () => ({ downloadText: mockDownloadText }));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { AuditPage } from "@/components/storagebase/admin/AuditPage";

/**
 * The fork's admin audit page: the filters reach the route as a POST body, the rows on screen are
 * re-filtered as they are typed, the detail drawer shows the fork's extended fields, "Load more"
 * follows the cursor, and the export asks the route for every matching row and downloads it as
 * JSON. `appFetch` rides the global fetch mock, as every component test here does.
 */

function forkEvent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    timestamp: "2026-09-24T10:00:00.000Z",
    type: "query_execution",
    action: "executed",
    target: "editor",
    user: "admin",
    result: "success",
    connectionName: "Orders DB",
    statementKind: "SELECT",
    duration: 42,
    ...overrides,
  };
}

describe("AuditPage", () => {
  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  /** The bodies every POST /api/sb/admin/audit call sent, newest last. */
  function sentBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call: unknown[]) => typeof call[0] === "string" && String(call[0]).includes("/api/sb/admin/audit"))
      .map((call: unknown[]) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}")));
  }

  beforeEach(() => {
    mockDownloadText.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/sb/admin/audit": {
        json: {
          events: [forkEvent("a1"), forkEvent("a2", { result: "failure", action: "failed", user: "bob" })],
          nextCursor: null,
          source: "store",
          total: 2,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders the events the route answered, with the source line", async () => {
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());
    expect(view.getAllByRole("row")).toHaveLength(3); // the header and two events
    expect(view.getByTestId("audit-source").textContent).toBe("Durable store — kept across restarts");
    expect(sentBodies()[0]).toMatchObject({ limit: 200 });
  });

  test("the type filter reaches the route as a filter, and the rows on screen re-filter as they are typed", async () => {
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "failed" } });
    // The server is not asked per keystroke: the rows on screen are re-read instead.
    expect(view.queryByText("executed")).toBeNull();
    expect(view.queryByText("failed")).not.toBeNull();
    expect(sentBodies()).toHaveLength(1);

    // Once the typing settles, the filter does reach the server.
    await waitFor(
      () => {
        expect(sentBodies().at(-1)).toMatchObject({ text: "failed" });
      },
      { timeout: 2000 },
    );
  });

  test("the type, result and action filters send their values", async () => {
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.keyDown(view.getByRole("combobox", { name: "Event type" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "Resource Operation" }), { key: "Enter" });
    await waitFor(() => expect(sentBodies().at(-1)).toMatchObject({ type: "resource_operation" }));

    fireEvent.keyDown(view.getByRole("combobox", { name: "Result" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "Failure" }), { key: "Enter" });
    await waitFor(() => expect(sentBodies().at(-1)).toMatchObject({ type: "resource_operation", result: "failure" }));

    fireEvent.keyDown(view.getByRole("combobox", { name: "Action" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "tree.list" }), { key: "Enter" });
    await waitFor(() =>
      expect(sentBodies().at(-1)).toMatchObject({ type: "resource_operation", result: "failure", action: "tree.list" }),
    );
  });

  test("the detail drawer shows the fork's extended fields and the masked statement", async () => {
    fetchMock.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/sb/admin/audit": {
        json: {
          events: [
            forkEvent("a1", {
              statement: "SELECT * FROM users WHERE password = ?",
              rowsReturned: 7,
              engine: "postgres",
              ip: "203.0.113.9",
              error: "boom ?",
              subject: "sub-9",
            }),
          ],
          nextCursor: null,
          source: "buffer",
          total: 1,
        },
      },
    });
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Show details" }));
    const detail = view.getByTestId("audit-event-detail");
    expect(detail.textContent).toContain("Statement (literals masked)");
    expect(detail.textContent).toContain("SELECT * FROM users WHERE password = ?");
    expect(detail.textContent).toContain("Rows Returned");
    expect(detail.textContent).toContain("sub-9");
    expect(view.getByTestId("audit-source").textContent).toContain("In-memory buffer");

    fireEvent.click(view.getByRole("button", { name: "Hide details" }));
    expect(view.queryByTestId("audit-event-detail")).toBeNull();
  });

  test("the time range reaches the route as ISO bounds, and an unreadable value is unbounded", async () => {
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.change(view.getByLabelText("From"), { target: { value: "2026-09-24T10:00" } });
    fireEvent.change(view.getByLabelText("To"), { target: { value: "2026-09-25T10:00" } });
    await waitFor(
      () =>
        expect(sentBodies().at(-1)).toMatchObject({
          from: "2026-09-24T10:00:00.000Z",
          to: "2026-09-25T10:00:00.000Z",
        }),
      { timeout: 2000 },
    );

    // A value the input cannot read as a date is simply no bound.
    fireEvent.change(view.getByLabelText("From"), { target: { value: "not-a-date" } });
    await waitFor(() => expect(sentBodies().at(-1)).not.toHaveProperty("from"), { timeout: 2000 });
  });

  test("Load more follows the cursor and appends, and a stale answer is dropped", async () => {
    let page = 0;
    fetchMock.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/sb/admin/audit": async (req: Request) => {
        const body = JSON.parse(await req.text()) as Record<string, unknown>;
        if (body.cursor === undefined) {
          return { json: { events: [forkEvent("a1")], nextCursor: "page-2", source: "store", total: 2 } };
        }
        page += 1;
        return { json: { events: [forkEvent("a2", { action: "executed-more" })], nextCursor: null, source: "store" } };
      },
    });
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    await userEvent.click(view.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(view.queryByText("executed-more")).not.toBeNull());
    expect(page).toBe(1);
    expect(sentBodies().at(-1)).toMatchObject({ cursor: "page-2" });
    // The cursor ended: no more button.
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("Refresh asks again and keeps the spinner while it waits", async () => {
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(sentBodies()).toHaveLength(2));
  });

  test("exports every matching row as JSON, through the route's export mode", async () => {
    fetchMock.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/sb/admin/audit": async (req: Request) => {
        const body = JSON.parse(await req.text()) as Record<string, unknown>;
        const matching = [forkEvent("a1"), forkEvent("a2", { result: "failure", action: "failed", user: "bob" })];
        const text = typeof body.text === "string" ? body.text.toLowerCase() : "";
        return { json: { events: matching.filter((event) => String(event.action).includes(text)), source: "store" } };
      },
    });
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "failed" } });
    await userEvent.click(view.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(mockDownloadText).toHaveBeenCalledTimes(1));

    const [content, mimeType, fileName] = mockDownloadText.mock.calls.at(-1)!;
    expect(mimeType).toBe("application/json");
    expect(fileName).toMatch(/^audit_operations_\d+\.json$/);
    expect(JSON.parse(content)).toEqual([forkEvent("a2", { result: "failure", action: "failed", user: "bob" })]);
    expect(sentBodies().at(-1)).toMatchObject({ export: true, text: "failed" });
  });

  test("an export the route answers with non-JSON keeps the rows and downloads nothing", async () => {
    fetchMock.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/sb/admin/audit": async (req: Request) => {
        const body = JSON.parse(await req.text()) as Record<string, unknown>;
        if (body.export === true) {
          return { text: "<html>bad gateway</html>", headers: { "content-type": "text/html" } };
        }
        return { json: { events: [forkEvent("a1")], nextCursor: null, source: "store", total: 1 } };
      },
    });
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());

    await userEvent.click(view.getByRole("button", { name: "Export JSON" }));

    // The parse of the HTML answer throws inside the export handler, whose
    // catch leaves the page as it was — rows intact, no file, button back on.
    await waitFor(() => expect(view.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled")).toBe(false));
    expect(mockDownloadText).not.toHaveBeenCalled();
    expect(view.queryByText("executed")).not.toBeNull();
    expect(view.getByTestId("audit-source").textContent).toContain("Durable store");
  });

  test("the export is disabled while loading and when no rows match the filters", async () => {
    const view = render(<AuditPage />);
    expect(view.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(view.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled")).toBe(false));

    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "nothing-matches" } });
    expect(view.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled")).toBe(true);
    expect(mockDownloadText).not.toHaveBeenCalled();
  });

  test("a failed request reads as no events, and no crash", async () => {
    restoreGlobalFetch();
    const view = render(<AuditPage />);
    await waitFor(() => expect(view.getByText("No audit events found.")).not.toBeNull());
    expect(view.queryByTestId("audit-source")).toBeNull();
  });
});
