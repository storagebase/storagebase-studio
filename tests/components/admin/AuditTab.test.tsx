import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

setupRechartssMock();
setupFramerMotionMock();

// Mock date-fns to avoid complex date computations in tests
mock.module("date-fns", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  format: (date: Date, fmt: string) => "Mon",
  subDays: (date: Date, days: number) => new Date(date.getTime() - days * 86400000),
  startOfDay: (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()),
}));

// Reassignable so a test can render the Queries/Stats tabs against an empty
// history (the idiom OperationsTab.test.tsx uses for mockConnectionsList).
// `beforeEach` restores the two-item default before every test.
const defaultHistory = () => [
  {
    id: "h1",
    query: "SELECT 1",
    executedAt: new Date(),
    executionTime: 10,
    rowCount: 1,
    status: "success",
    connectionId: "c1",
    connectionName: "TestDB",
  },
  {
    id: "h2",
    query: "DROP TABLE x",
    executedAt: new Date(),
    executionTime: 5,
    rowCount: 0,
    status: "error",
    error: "denied",
    connectionId: "c1",
    connectionName: "TestDB",
  },
];

let mockHistory: ReturnType<typeof defaultHistory> = defaultHistory();

const mockDownloadText = mock((_content: string, _mimeType: string, _fileName: string) => {});
mock.module("@/lib/export/download", () => ({ downloadText: mockDownloadText }));

mock.module("@/lib/storage", () => ({
  storage: {
    getHistory: mock(() => mockHistory),
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { AuditTab } from "@/components/admin/tabs/AuditTab";

// =============================================================================
// AuditTab Tests
// =============================================================================

/** Every `/api/admin/audit` URL requested so far, in call order. */
function auditCalls(fetchMock: ReturnType<typeof mockGlobalFetch>): string[] {
  return fetchMock.mock.calls
    .map((c: unknown[]) => (typeof c[0] === "string" ? c[0] : ""))
    .filter((url: string) => url.includes("/api/admin/audit"));
}

describe("AuditTab", () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockDownloadText.mockClear();
    mockHistory = defaultHistory();
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": {
        json: {
          events: [
            {
              id: "a1",
              timestamp: new Date().toISOString(),
              type: "maintenance",
              action: "VACUUM",
              target: "users",
              connectionName: "TestDB",
              user: "admin",
              result: "success",
              duration: 120,
            },
            {
              id: "a2",
              timestamp: new Date().toISOString(),
              type: "kill_session",
              action: "KILL",
              target: "PID:5678",
              connectionName: "TestDB",
              user: "admin",
              result: "failure",
              duration: 50,
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("renders 3 tabs (Operations, Queries, Stats)", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Operations")).not.toBeNull();
    expect(queryByText("Queries")).not.toBeNull();
    expect(queryByText("Stats")).not.toBeNull();
  });

  test.each(["csv", "json"])("exports only the filtered operations as %s", async (format) => {
    const event = {
      id: "audit-export",
      timestamp: "2026-09-09T10:00:00.000Z",
      type: "maintenance",
      action: "VACUUM",
      target: 'users,"archive"\n2026',
      connectionName: "团队,DB",
      user: "=admin",
      result: "success",
      duration: 0,
      details: 'completed "safely"',
      ip: "192.0.2.1",
      reason: "origin_mismatch",
      bucket: "login_client",
      correlationId: "op-1",
    };
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": (req: Request) => ({
        json: {
          events:
            new URL(req.url).searchParams.get("type") === "maintenance"
              ? [event, { ...event, id: "hidden-by-search", target: "orders" }]
              : [event, { ...event, id: "hidden-by-type", type: "kill_session", action: "KILL" }],
        },
      }),
    });
    const user = userEvent.setup();
    const view = render(<AuditTab />);
    await waitFor(() => expect(view.queryByText("KILL")).not.toBeNull());
    fireEvent.keyDown(view.getByRole("combobox", { name: "Event type" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "Maintenance" }), { key: "Enter" });
    await waitFor(() => expect(view.queryByText("orders")).not.toBeNull());
    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "archive" } });
    await user.click(view.getByRole("button", { name: "Export" }));
    await user.click(view.getByRole("menuitem", { name: `Export as ${format.toUpperCase()}` }));
    const [content, mime, fileName] = mockDownloadText.mock.calls.at(-1)!;
    expect(fileName).toMatch(new RegExp(`^audit_operations_\\d+\\.${format}$`));
    if (format === "json") {
      expect(mime).toBe("application/json");
      expect(content).toBe(JSON.stringify([event], null, 2));
    } else {
      expect(mime).toBe("text/csv");
      expect(content).toBe(
        'Timestamp,Type,Action,Target,Connection,User,Result,Duration (ms),Details,IP,Reason,Bucket,Correlation ID,Role,User Agent,Forwarded For,Connection ID,Engine,Host,Database,Statement Kind,Statement,Statement Truncated,Rows Returned,Rows Affected,Error,Query ID,ID\n2026-09-09T10:00:00.000Z,maintenance,VACUUM,"users,""archive""\n2026","团队,DB","\'=admin",success,0,"completed ""safely""",192.0.2.1,origin_mismatch,login_client,op-1,,,,,,,,,,,,,,,audit-export',
      );
    }
  });

  test.each(["csv", "json"])(
    "exports only filtered query history as %s with the history export shape",
    async (format) => {
      mockHistory = [
        { ...defaultHistory()[0], query: "SELECT 'selected'", executedAt: new Date("2026-09-09T10:00:00Z") },
        { ...defaultHistory()[1], query: "SELECT 'selected'" },
        { ...defaultHistory()[0], id: "h3", query: "SELECT 'hidden'" },
      ];
      const user = userEvent.setup();
      const view = render(<AuditTab />);
      await user.click(view.getByRole("tab", { name: "Queries" }));
      fireEvent.keyDown(view.getByRole("combobox"), { key: "ArrowDown" });
      fireEvent.keyDown(view.getByRole("option", { name: "Success" }), { key: "Enter" });
      fireEvent.change(view.getByPlaceholderText("Search query..."), { target: { value: "selected" } });
      await user.click(view.getByRole("button", { name: "Export" }));
      await user.click(view.getByRole("menuitem", { name: `Export as ${format.toUpperCase()}` }));
      const [content, mime, fileName] = mockDownloadText.mock.calls.at(-1)!;
      expect(fileName).toMatch(new RegExp(`^query_history_\\d+\\.${format}$`));
      if (format === "json") {
        expect(mime).toBe("application/json");
        expect(content).toBe(JSON.stringify([mockHistory[0]], null, 2));
      } else {
        expect(mime).toBe("text/csv");
        expect(content).toBe(
          "Executed At,Status,Connection,Tab,Execution Time (ms),Rows,Query,Error\n2026-09-09T10:00:00.000Z,success,TestDB,,10,1,SELECT 'selected',",
        );
      }
    },
  );

  test("audit export is disabled while refreshing and when no filtered rows remain", async () => {
    const view = render(<AuditTab />);
    expect(view.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(view.queryByText("VACUUM")).not.toBeNull());
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    expect(view.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(view.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "missing-row" } });
    expect(view.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    expect(mockDownloadText).not.toHaveBeenCalled();
  });

  test("query export includes every matching row beyond the table display limit", async () => {
    mockHistory = Array.from({ length: 201 }, (_, index) => ({ ...defaultHistory()[0], id: `query-${index}` }));
    const user = userEvent.setup();
    const view = render(<AuditTab />);
    await user.click(view.getByRole("tab", { name: "Queries" }));
    expect(view.container.querySelectorAll("tbody tr").length).toBe(200);
    await user.click(view.getByRole("button", { name: "Export" }));
    await user.click(view.getByRole("menuitem", { name: "Export as JSON" }));
    expect(JSON.parse(mockDownloadText.mock.calls.at(-1)![0])).toHaveLength(201);
    fireEvent.change(view.getByPlaceholderText("Search query..."), { target: { value: "no-match" } });
    expect(view.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
  });

  test("operations tab fetches audit events", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // Wait for the fetch to complete and events to render
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const auditCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return url.includes("/api/admin/audit");
      });
      expect(auditCall).not.toBeUndefined();
    });

    // Events should render after fetch
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
      expect(queryByText("KILL")).not.toBeNull();
    });
  });

  test("queries tab shows query history", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Queries tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    // Query history from mock storage
    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x")).not.toBeNull();
    });
  });

  test("stats tab shows summary cards", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Stats tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const statsTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Stats")) as HTMLElement;
    await user.click(statsTab);

    // Summary cards show total queries, success rate, etc.
    await waitFor(() => {
      expect(queryByText("Total Queries")).not.toBeNull();
      expect(queryByText("Success Rate")).not.toBeNull();
      expect(queryByText("Avg Duration")).not.toBeNull();
      expect(queryByText("Failed")).not.toBeNull();
    });
  });

  /**
   * The query-activity chart's tooltip is inline-styled by recharts, so it cannot
   * read the CSS tokens. Left hardcoded it stayed a black card on a white page —
   * which is exactly how it shipped until it was reported.
   */
  async function statsTooltipUnder(theme: "dark" | "light") {
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(theme);

    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { container } = renderResult!;

    const statsTab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes("Stats"),
    ) as HTMLElement;
    await user.click(statsTab);

    const tooltip = await waitFor(() => {
      const el = container.querySelector("[data-testid='mock-tooltip']");
      expect(el).not.toBeNull();
      return el!;
    });
    return { bg: tooltip.getAttribute("data-bg"), color: tooltip.getAttribute("data-color") };
  }

  test("the stats chart tooltip keeps its dark card in the dark theme", async () => {
    expect(await statsTooltipUnder("dark")).toEqual({ bg: "#18181b", color: "#a1a1aa" });
  });

  test("and turns into a white card in the light theme", async () => {
    expect(await statsTooltipUnder("light")).toEqual({ bg: "#ffffff", color: "#3f3f46" });
  });

  test("search filter works in operations tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText } = renderResult!;

    // Wait for events to load
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
    });

    // Find the search input and type a search query
    const searchInput = getByPlaceholderText("Search...");
    expect(searchInput).not.toBeNull();

    // Use userEvent for proper input handling in happy-dom
    await user.clear(searchInput);
    await user.type(searchInput, "VACUUM");

    // VACUUM should still be visible, KILL should be filtered out.
    // The filtered-out half is written `=== null` rather than `toBeNull()` on the node, here and
    // in the two other filter tests below: a FAILING poll hands bun a live happy-dom element and
    // bun walks its whole object graph to build the diff, 301 ms for a 260-node subtree measured.
    // A few of those and waitFor's 5 s budget is spent, so a briefly busy machine reds a healthy
    // test. The boolean costs 0 ms. The present half stays as it is: it fails on `null`, which is
    // cheap to print.
    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
      expect(queryByText("KILL") === null).toBe(true);
    });
  });

  test("type filter dropdown present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // The type filter select should show "All Types" by default
    expect(queryByText("All Types")).not.toBeNull();
  });

  test("shows empty state when audit fetch fails", async () => {
    // Override the fetch installed in beforeEach with one that rejects,
    // exercising the catch path (setEvents([])) and the empty-state UI.
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("No audit events found.")).not.toBeNull();
      expect(queryByText(/maintenance tasks are run/)).not.toBeNull();
    });
  });

  test("search filter works in queries tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText, container } = renderResult!;

    // Switch to the Queries tab
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
    });

    // Type a search query — only matching history items remain
    const searchInput = getByPlaceholderText("Search query...");
    await user.type(searchInput, "select");

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x") === null).toBe(true);
    });
  });

  test("status filter works in queries tab", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container, baseElement } = renderResult!;

    // Switch to the Queries tab
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
      expect(queryByText("DROP TABLE x")).not.toBeNull();
    });

    // Open the status select via keyboard (happy-dom lacks full pointer support)
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(selectTrigger).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });

    // Pick the "Error" option from the portaled listbox
    const options = Array.from(baseElement.querySelectorAll('[role="option"]'));
    const errorOption = options.find((o) => o.textContent?.trim() === "Error") as HTMLElement;
    expect(errorOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(errorOption, { key: "Enter" });
    });

    // Only the error-status history item remains
    await waitFor(() => {
      expect(queryByText("DROP TABLE x")).not.toBeNull();
      expect(queryByText("SELECT 1") === null).toBe(true);
    });
  });
  test("changing the type filter refetches with the type param", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { container, baseElement } = renderResult!;

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(1);
    });

    // Open the type select via keyboard (happy-dom lacks full pointer support)
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });

    const options = Array.from(baseElement.querySelectorAll('[role="option"]'));
    const killOption = options.find((o) => o.textContent?.trim() === "Kill Session") as HTMLElement;
    expect(killOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(killOption, { key: "Enter" });
    });

    // A second request goes out, carrying the picked type as a query param.
    await waitFor(() => {
      const calls = auditCalls(fetchMock);
      expect(calls.length).toBe(2);
      expect(calls[1]).toContain("type=kill_session");
    });
  });

  test("the Refresh button refetches the audit events", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { getByText } = renderResult!;

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(1);
    });

    await user.click(getByText("Refresh"));

    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(2);
    });
  });

  test("queries tab shows the empty state when nothing matches the search", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTab);

    await waitFor(() => {
      expect(queryByText("SELECT 1")).not.toBeNull();
    });

    await user.type(getByPlaceholderText("Search query..."), "zzzz");

    await waitFor(() => {
      expect(queryByText("No query history found.")).not.toBeNull();
    });
  });

  test("stats tab shows the empty states when there is no query history", async () => {
    mockHistory = [];
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const statsTab = Array.from(allTriggers).find((t) => t.textContent?.includes("Stats")) as HTMLElement;
    await user.click(statsTab);

    await waitFor(() => {
      expect(queryByText("No query history yet.")).not.toBeNull();
      expect(queryByText("No data yet.")).not.toBeNull();
    });
  });

  /**
   * A refresh that is still in flight when the Type filter changes must not be
   * allowed to overwrite the newer filter's rows: the settled table has to agree
   * with the Type control, whichever response comes back last.
   */
  test("a refresh overtaken by a type change does not put back the old filter's rows", async () => {
    const allEvents = [
      {
        id: "a1",
        timestamp: new Date().toISOString(),
        type: "maintenance",
        action: "VACUUM",
        target: "users",
        connectionName: "TestDB",
        user: "admin",
        result: "success",
        duration: 120,
      },
      {
        id: "a2",
        timestamp: new Date().toISOString(),
        type: "kill_session",
        action: "KILL",
        target: "PID:5678",
        connectionName: "TestDB",
        user: "admin",
        result: "failure",
        duration: 50,
      },
    ];
    const killEvents = [allEvents[1]];

    // Held open so the "all" refresh can be made to resolve AFTER the newer
    // kill_session request — the overtaking order the race needs.
    let releaseAll: (() => void) | null = null;
    let holdAll: Promise<void> | null = null;

    fetchMock = mockGlobalFetch({
      "/api/admin/audit": async (req: Request) => {
        if (new URL(req.url).searchParams.get("type") === "kill_session") {
          return { json: { events: killEvents } };
        }
        if (holdAll) await holdAll;
        return { json: { events: allEvents } };
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByText, container, baseElement } = renderResult!;

    // The Action cell of every rendered row — compared as a list so a failure
    // names the rows on screen instead of dumping a DOM node.
    const rowActions = () =>
      Array.from(container.querySelectorAll("tbody tr td:nth-child(3)")).map((c) => c.textContent);

    await waitFor(() => {
      expect(queryByText("VACUUM")).not.toBeNull();
    });

    holdAll = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    // Refresh under type=all — this request is the one that will lose the race.
    await act(async () => {
      fireEvent.click(getByText("Refresh"));
    });
    await waitFor(() => {
      expect(auditCalls(fetchMock).length).toBe(2);
    });

    // While it hangs, switch the Type filter to Kill Session.
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });
    const killOption = Array.from(baseElement.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.trim() === "Kill Session",
    ) as HTMLElement;
    expect(killOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(killOption, { key: "Enter" });
    });

    // The newer request wins first: only kill-session rows on screen.
    await waitFor(() => {
      expect(rowActions()).toEqual(["KILL"]);
    });

    // Now let the stale refresh land. It must change nothing.
    await act(async () => {
      releaseAll!();
      await holdAll;
    });

    expect(selectTrigger.textContent).toContain("Kill Session");
    expect(rowActions()).toEqual(["KILL"]);
  });
});

// =============================================================================
// query_execution events (StorageBase fork): the columns, the detail panel, the
// user / IP / result / free-text filters and the complete CSV export.
// =============================================================================

describe("AuditTab — query_execution events", () => {
  const queryEvent = {
    id: "q1",
    timestamp: "2026-09-20T08:00:00.000Z",
    type: "query_execution",
    action: "executed",
    target: "POST /api/db/query",
    connectionName: "Orders DB",
    user: "alice",
    role: "user",
    result: "success",
    duration: 12,
    ip: "203.0.113.9",
    forwardedFor: "203.0.113.9, 10.0.0.1",
    userAgent: "Mozilla/5.0",
    connectionId: "conn-1",
    engine: "postgres",
    host: "db.internal:5432",
    database: "orders",
    statementKind: "UPDATE",
    statement: "UPDATE orders SET paid = ? WHERE id = ?",
    statementTruncated: true,
    rowsReturned: 0,
    rowsAffected: 3,
    queryId: "qid-1",
  };
  const failedEvent = {
    id: "q2",
    timestamp: "2026-09-20T08:01:00.000Z",
    type: "query_execution",
    action: "failed",
    target: "POST /api/db/query",
    connectionName: "Orders DB",
    user: "bob",
    result: "failure",
    reason: "query_failed",
    ip: "198.51.100.7",
    statementKind: "SELECT",
    statement: "SELECT * FROM nope",
    rowsReturned: 5,
    error: "QueryError: relation ? does not exist",
  };
  const loginEvent = {
    id: "l1",
    timestamp: "2026-09-20T08:02:00.000Z",
    type: "login_success",
    action: "login",
    target: "POST /api/auth/login",
    user: "carol",
    result: "success",
  };

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockDownloadText.mockClear();
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": { json: { events: [queryEvent, failedEvent, loginEvent] } },
    });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  /** The User cell of every rendered event row. */
  function rowUsers(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("tbody tr td:nth-child(6)")).map((c) => c.textContent ?? "");
  }

  async function renderLoaded() {
    const view = render(<AuditTab />);
    await waitFor(() => expect(view.queryByText("executed")).not.toBeNull());
    return view;
  }

  test("asks for the whole server buffer so the filters search all of it", async () => {
    await renderLoaded();
    expect(auditCalls(fetchMock)[0]).toContain("limit=1000");
  });

  test("shows the IP, statement kind and rows columns, preferring affected over returned rows", async () => {
    const view = await renderLoaded();
    expect(view.queryByText("203.0.113.9")).not.toBeNull();
    expect(view.queryByText("UPDATE")).not.toBeNull();
    const rows = Array.from(view.container.querySelectorAll("tbody tr td:nth-child(9)")).map((c) => c.textContent);
    expect(rows).toEqual(["3", "5", "-"]);
  });

  test("expands a row into its detail panel with the masked statement, and collapses it again", async () => {
    const user = userEvent.setup();
    const view = await renderLoaded();
    const [firstToggle] = view.getAllByRole("button", { name: "Show details" });
    await user.click(firstToggle);

    const detail = view.getByTestId("audit-event-detail");
    expect(detail.textContent).toContain("alice (user)");
    expect(detail.textContent).toContain("203.0.113.9, 10.0.0.1");
    expect(detail.textContent).toContain("Mozilla/5.0");
    expect(detail.textContent).toContain("db.internal:5432");
    expect(detail.textContent).toContain("Statement (literals masked) — truncated");
    expect(detail.querySelector("pre")?.textContent).toBe("UPDATE orders SET paid = ? WHERE id = ?");

    await user.click(view.getByRole("button", { name: "Hide details" }));
    expect(view.queryByTestId("audit-event-detail") === null).toBe(true);
  });

  test("a failure's detail names its reason and error; an event with no statement shows no statement block", async () => {
    const user = userEvent.setup();
    const view = await renderLoaded();
    const toggles = view.getAllByRole("button", { name: "Show details" });
    await user.click(toggles[1]);
    await user.click(toggles[2]);

    const [failed, login] = view.getAllByTestId("audit-event-detail");
    expect(failed.textContent).toContain("failure (query_failed)");
    expect(failed.textContent).toContain("QueryError: relation ? does not exist");
    expect(failed.textContent).toContain("Statement (literals masked)");
    expect(failed.textContent).not.toContain("truncated");
    expect(login.querySelector("pre") === null).toBe(true);
    expect(login.textContent).toContain("carol");
  });

  test("filters by result", async () => {
    const view = await renderLoaded();
    fireEvent.keyDown(view.getByRole("combobox", { name: "Result" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "Failure" }), { key: "Enter" });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["bob"]));
  });

  test("filters by user", async () => {
    const view = await renderLoaded();
    fireEvent.change(view.getByPlaceholderText("User..."), { target: { value: "ALI" } });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["alice"]));
  });

  test("filters by IP, matching the forwarded chain too", async () => {
    const view = await renderLoaded();
    fireEvent.change(view.getByPlaceholderText("IP..."), { target: { value: "10.0.0.1" } });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["alice"]));
    fireEvent.change(view.getByPlaceholderText("IP..."), { target: { value: "198.51" } });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["bob"]));
  });

  test("the free-text search reads the statement and the error", async () => {
    const view = await renderLoaded();
    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "set paid" } });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["alice"]));
    fireEvent.change(view.getByPlaceholderText("Search..."), { target: { value: "does not exist" } });
    await waitFor(() => expect(rowUsers(view.container)).toEqual(["bob"]));
  });

  test("offers the query_execution type in the type filter", async () => {
    const view = await renderLoaded();
    fireEvent.keyDown(view.getByRole("combobox", { name: "Event type" }), { key: "ArrowDown" });
    fireEvent.keyDown(view.getByRole("option", { name: "Query Execution" }), { key: "Enter" });
    await waitFor(() => expect(auditCalls(fetchMock).at(-1)).toContain("type=query_execution"));
  });

  test("the CSV export carries every query_execution field", async () => {
    const user = userEvent.setup();
    const view = await renderLoaded();
    fireEvent.change(view.getByPlaceholderText("User..."), { target: { value: "alice" } });
    await user.click(view.getByRole("button", { name: "Export" }));
    await user.click(view.getByRole("menuitem", { name: "Export as CSV" }));
    const [content] = mockDownloadText.mock.calls.at(-1)!;
    expect(content.split("\n")[1]).toBe(
      "2026-09-20T08:00:00.000Z,query_execution,executed,POST /api/db/query,Orders DB,alice,success,12,,203.0.113.9,,,," +
        'user,Mozilla/5.0,"203.0.113.9, 10.0.0.1",conn-1,postgres,db.internal:5432,orders,UPDATE,' +
        "UPDATE orders SET paid = ? WHERE id = ?,true,0,3,,qid-1,q1",
    );
  });
});
