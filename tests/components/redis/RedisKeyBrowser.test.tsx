import "../../setup-dom";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";
import { installLayout } from "../resources/kafka/kafka-server";
import { RedisKeyBrowserDock } from "@/components/redis/RedisKeyBrowserDock";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryTab } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "cache-1",
  name: "Cache",
  type: "redis",
  host: "cache.internal",
  port: 6379,
  createdAt: new Date(0),
};
const capabilities = { queryDialect: "redis", queryLanguage: "json" } as unknown as ProviderCapabilities;

type Body = Record<string, unknown>;
interface Server {
  readonly scans: Body[];
  readonly metas: Body[];
}

/**
 * A fake of the three routes the browser calls. `pages` answers SCAN by cursor; every key's type
 * is "hash" unless named in `types`.
 */
function installServer(
  options: {
    pages?: Record<string, { keys: string[]; cursor: string; stoppedBy?: string }>;
    byMatch?: Record<string, string[]>;
    containers?: MockFetchResponse;
    scanError?: string;
    types?: Record<string, string>;
  } = {},
): Server {
  const server: Server = { scans: [], metas: [] };
  const pages = options.pages ?? { "0": { keys: ["user:1:name", "user:2:name", "counter"], cursor: "0" } };
  mockGlobalFetch({
    "/api/redis/keys/meta": async (req) => {
      const body = (await req.json()) as Body;
      server.metas.push(body);
      return {
        json: {
          entries: (body.keys as string[]).map((key) => ({
            key,
            type: options.types?.[key] ?? "hash",
            ttl: key === "counter" ? 90 : -1,
            memory: 64,
          })),
        },
      };
    },
    "/api/redis/keys": async (req) => {
      const body = (await req.json()) as Body;
      server.scans.push(body);
      if (options.scanError !== undefined) return { status: 400, json: { error: options.scanError } };
      if (typeof body.match === "string" && options.byMatch?.[body.match] !== undefined) {
        const keys = options.byMatch[body.match];
        return {
          json: { keys, cursor: "0", truncated: false, scanned: keys.length, iterations: 1, stoppedBy: "complete" },
        };
      }
      const page = pages[body.cursor as string] ?? { keys: [], cursor: "0" };
      return {
        json: {
          keys: page.keys,
          cursor: page.cursor,
          truncated: page.cursor !== "0",
          scanned: page.keys.length,
          iterations: 1,
          stoppedBy: page.stoppedBy ?? (page.cursor === "0" ? "complete" : "limit"),
        },
      };
    },
    "/api/db/objects/containers": options.containers ?? {
      json: [0, 1, 2].map((n) => ({ path: [String(n)], name: String(n), level: 0, isSessionDefault: n === 0 })),
    },
  });
  return server;
}

function renderDock(conn: DatabaseConnection = connection) {
  let tabs: QueryTab[] = [];
  const setTabs = mock((update: QueryTab[] | ((current: QueryTab[]) => QueryTab[])) => {
    tabs = typeof update === "function" ? update(tabs) : update;
  });
  const setActiveTabId = mock((_id: string) => {});
  const runQuery = mock((_query: string, _tabId: string) => {});
  const utils = render(
    <RedisKeyBrowserDock
      connection={conn}
      capabilities={capabilities}
      tabs={{ setTabs, setActiveTabId }}
      runQuery={runQuery}
    />,
  );
  return { ...utils, tabs: () => tabs, setActiveTabId, runQuery };
}

async function openBrowser() {
  fireEvent.click(screen.getByRole("button", { name: "Keys" }));
  await waitFor(() => expect(screen.getByTestId("redis-key-status").textContent).toContain("loaded"));
}

function keyRows() {
  return screen.queryAllByTestId("redis-key-row");
}

let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installLayout();
});
afterAll(() => restoreLayout());

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

describe("RedisKeyBrowserDock", () => {
  test("renders nothing for a connection that does not speak Redis", () => {
    const { container } = render(
      <RedisKeyBrowserDock
        connection={connection}
        capabilities={{ queryDialect: "postgres" } as unknown as ProviderCapabilities}
        tabs={{ setTabs: mock(), setActiveTabId: mock() }}
        runQuery={mock()}
      />,
    );
    expect(container.innerHTML).toBe("");
    const none = render(
      <RedisKeyBrowserDock
        connection={null}
        capabilities={capabilities}
        tabs={{ setTabs: mock(), setActiveTabId: mock() }}
        runQuery={mock()}
      />,
    );
    expect(none.container.innerHTML).toBe("");
  });

  test("opens, scans the session database, groups by prefix and counts what is loaded", async () => {
    const server = installServer();
    renderDock();
    await openBrowser();

    expect(server.scans[0]).toMatchObject({ connection: expect.any(Object), database: 0, cursor: "0" });
    expect(screen.getByTestId("redis-key-status").textContent).toBe("3 of 3 loaded - every key");
    const groups = screen.getAllByTestId("redis-key-group");
    expect(groups.map((group) => group.textContent)).toEqual(["user:2"]);
    expect(keyRows().map((row) => row.textContent)).toEqual(["counter"]);

    fireEvent.click(groups[0]);
    expect(screen.getAllByTestId("redis-key-group")).toHaveLength(3);
    fireEvent.click(screen.getByText("user:1:"));
    expect(keyRows().map((row) => row.getAttribute("title"))).toEqual(["user:1:name", "counter"]);

    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(screen.queryAllByTestId("redis-key-group")).toHaveLength(0);
    expect(keyRows().map((row) => row.getAttribute("title"))).toEqual(["counter", "user:1:name", "user:2:name"]);

    // Metadata arrives for the keys on screen.
    await waitFor(() => expect(screen.getAllByTestId("redis-key-meta").length).toBeGreaterThan(0));
    expect(server.metas[0]).toMatchObject({ database: 0 });
    expect(screen.getAllByTestId("redis-key-meta")[0].textContent).toBe("hash1m64 B");
  });

  test("text, glob and regex search, case sensitivity, highlight and regex validation", async () => {
    installServer({ pages: { "0": { keys: ["User:1", "user:22", "order:9"], cursor: "0" } } });
    renderDock();
    await openBrowser();
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    const search = screen.getByLabelText("Search keys");

    fireEvent.change(search, { target: { value: "user" } });
    await waitFor(() => expect(keyRows()).toHaveLength(2));
    expect(screen.getByTestId("redis-key-status").textContent).toContain("2 of 3 loaded");
    expect(screen.getAllByText("User")[0].tagName).toBe("MARK");

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    await waitFor(() => expect(keyRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Glob" }));
    fireEvent.change(search, { target: { value: "user:?" } });
    await waitFor(() => expect(keyRows()).toHaveLength(0));
    expect(screen.getByText("No loaded keys match.")).toBeDefined();
    fireEvent.change(search, { target: { value: "user:??" } });
    await waitFor(() => expect(keyRows().map((row) => row.getAttribute("title"))).toEqual(["user:22"]));

    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    fireEvent.change(search, { target: { value: "\\d{2}" } });
    await waitFor(() => expect(keyRows().map((row) => row.getAttribute("title"))).toEqual(["user:22"]));
    expect(screen.getByText("22").tagName).toBe("MARK");

    fireEvent.change(search, { target: { value: "(" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toStartWith("Invalid pattern"));
    expect(search.getAttribute("aria-invalid")).toBe("true");
  });

  test("a search opens every group so a match is never hidden", async () => {
    installServer({ pages: { "0": { keys: ["a:b:target", "a:c:other"], cursor: "0" } } });
    renderDock();
    await openBrowser();
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "target" } });
    await waitFor(() => expect(keyRows().map((row) => row.getAttribute("title"))).toEqual(["a:b:target"]));
  });

  test("windows 20,000 keys to a screenful of rows", async () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => `k${i}`);
    installServer({ pages: { "0": { keys, cursor: "0" } } });
    renderDock();
    await openBrowser();
    expect(screen.getByTestId("redis-key-status").textContent).toContain("20,000 of 20,000");
    expect(keyRows().length).toBeGreaterThan(0);
    expect(keyRows().length).toBeLessThan(80);
  });

  test("load more resumes from the cursor; scan all pages to the end; server search sends MATCH", async () => {
    const server = installServer({
      pages: {
        "0": { keys: ["a"], cursor: "5" },
        "5": { keys: ["b"], cursor: "9", stoppedBy: "deadline" },
        "9": { keys: ["c"], cursor: "0" },
      },
      byMatch: { "*x\\*y*": ["x*y"] },
    });
    renderDock();
    await openBrowser();
    expect(screen.getByTestId("redis-key-status").textContent).toBe("1 of 1 loaded - more on the server");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByTestId("redis-key-status").textContent).toContain("2 of 2"));
    expect(server.scans[1]).toMatchObject({ cursor: "5", limit: 10_000 });
    expect(screen.getByTestId("redis-key-status").textContent).toContain("time budget reached");

    fireEvent.click(screen.getByRole("button", { name: "Scan all (bounded)" }));
    await waitFor(() => expect(screen.getByTestId("redis-key-status").textContent).toBe("3 of 3 loaded - every key"));
    // Bounded by what the browser may still hold: 50,000 minus the 2 already loaded.
    expect(server.scans[2]).toMatchObject({ cursor: "9", limit: 49_998 });
    expect((screen.getByRole("button", { name: "Load more" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "x*y" } });
    fireEvent.click(screen.getByRole("button", { name: "Search on server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Clear server search" }).parentElement?.textContent).toBe(
        "MATCH *x\\*y*",
      ),
    );
    expect(server.scans.at(-1)).toMatchObject({ cursor: "0", match: "*x\\*y*" });

    fireEvent.click(screen.getByRole("button", { name: "Clear server search" }));
    // Flush the click's rescan before waiting: without it the waitFor below
    // can start its async-act polling against the click's still-queued update
    // and never observe the settled DOM (the "stop cancels" test below flushes
    // the same way).
    await act(async () => {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear server search" })).toBeNull());
    expect(server.scans.at(-1)).not.toHaveProperty("match");

    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    expect((screen.getByRole("button", { name: "Search on server" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("the type filter and the database selector re-scan", async () => {
    const server = installServer();
    renderDock();
    await openBrowser();

    fireEvent.change(screen.getByLabelText("Key type"), { target: { value: "zset" } });
    await waitFor(() => expect(server.scans.at(-1)).toMatchObject({ type: "zset" }));
    fireEvent.change(screen.getByLabelText("Key type"), { target: { value: "" } });
    await waitFor(() => expect(server.scans.at(-1)).not.toHaveProperty("type"));

    await waitFor(() => expect(screen.getByRole("option", { name: "0 (session)" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "2" } });
    await waitFor(() => expect(server.scans.at(-1)).toMatchObject({ database: 2 }));
    await waitFor(() => expect(screen.getByTestId("redis-key-other-database")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(server.scans.at(-1)).toMatchObject({ database: 2, cursor: "0" }));
  });

  test("opening a key runs its type's bounded reader in a new tab", async () => {
    installServer({ types: { counter: "list" } });
    const { tabs, setActiveTabId, runQuery } = renderDock();
    await openBrowser();

    fireEvent.click(keyRows()[0]);
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(tabs()[0]).toMatchObject({ name: "counter", query: "LRANGE counter 0 99", type: "redis" });
    expect(setActiveTabId).toHaveBeenCalledWith(tabs()[0].id);
    await waitFor(() => expect(runQuery).toHaveBeenCalledWith("LRANGE counter 0 99", tabs()[0].id));
  });

  test("a key whose type cannot be read opens with TYPE", async () => {
    installServer();
    const fetchMock = globalThis.fetch;
    const { tabs } = renderDock();
    await openBrowser();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/meta")) return new Response("{}", { status: 500 });
      return fetchMock(input, init);
    }) as typeof fetch;
    fireEvent.click(keyRows()[0]);
    await waitFor(() => expect(tabs()[0]?.query).toBe("TYPE counter"));
  });

  test("keys outside the session database can be searched and copied but not opened", async () => {
    installServer({
      containers: {
        json: [0, 1].map((n) => ({ path: [String(n)], name: String(n), level: 0, isSessionDefault: n === 1 })),
      },
    });
    const { tabs } = renderDock();
    await openBrowser();
    await waitFor(() => expect(screen.getByTestId("redis-key-other-database").textContent).toContain("database 1"));
    fireEvent.click(keyRows()[0]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tabs()).toHaveLength(0);
  });

  test("copy writes the key name to the clipboard", async () => {
    installServer();
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderDock();
    await openBrowser();
    fireEvent.click(screen.getByRole("button", { name: "Copy key name counter" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("counter"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy key name counter" }).title).toBe("Copied"));

    writeText.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "End" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy key name counter" }).title).toBe("Copy key name"),
    );
  });

  test("keyboard: arrows move, right/left open and close a group, enter opens a key", async () => {
    installServer();
    const { tabs } = renderDock();
    await openBrowser();
    const list = screen.getByRole("listbox");
    const selected = () =>
      screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");

    expect(selected()?.textContent).toContain("user:");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getAllByTestId("redis-key-group")).toHaveLength(3);
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getAllByTestId("redis-key-group")).toHaveLength(1);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.getAllByTestId("redis-key-group")).toHaveLength(3);
    fireEvent.keyDown(list, { key: "ArrowLeft" });

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected()?.getAttribute("title")).toBe("counter");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    fireEvent.keyDown(list, { key: "x" });
    fireEvent.keyDown(list, { key: "c" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Home" });
    expect(selected()?.textContent).toContain("user:");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(tabs()[0]?.query).toBe("HGETALL counter"));
  });

  test("close hides the panel and reopening keeps what was loaded and typed", async () => {
    const server = installServer();
    renderDock();
    await openBrowser();
    fireEvent.change(screen.getByLabelText("Search keys"), { target: { value: "count" } });
    fireEvent.click(screen.getByRole("button", { name: "Close key browser" }));
    expect(screen.getByRole("complementary", { hidden: true }).className).toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect((screen.getByLabelText("Search keys") as HTMLInputElement).value).toBe("count");
    expect(server.scans).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
  });

  test("a failed scan and an unreadable database list are both shown", async () => {
    installServer({ scanError: "NOPERM scan", containers: { status: 500, json: {} } });
    renderDock({ ...connection, database: "4" });
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("NOPERM scan"));
    await waitFor(() => expect(screen.getByText(/Only the session database is offered/)).toBeDefined());
    expect(screen.getByRole("option", { name: "4 (session)" })).toBeDefined();
    expect(screen.getByTestId("redis-key-status").textContent).toBe("No keys loaded yet.");
  });

  test("stop cancels a scan in flight", async () => {
    let release: (() => void) | undefined;
    mockGlobalFetch({
      "/api/redis/keys/meta": { json: { entries: [] } },
      "/api/redis/keys": () =>
        new Promise<MockFetchResponse>((resolve) => {
          release = () =>
            resolve({
              json: { keys: ["late"], cursor: "0", truncated: false, scanned: 1, iterations: 1, stoppedBy: "complete" },
            });
        }),
      "/api/db/objects/containers": { json: [] },
    });
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    await waitFor(() => expect(screen.getByTestId("redis-key-status").textContent).toBe("Scanning..."));
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(screen.getByTestId("redis-key-status").textContent).toBe("No keys loaded yet.");
    await act(async () => release?.());
  });
});
