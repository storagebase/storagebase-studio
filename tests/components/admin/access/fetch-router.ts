import { mock } from "bun:test";

/**
 * A fetch double for the admin access tabs: answers by `METHOD path` (query string included when
 * a route is registered with one, ignored otherwise) and records every call with its JSON body.
 */

export type Answer = { status?: number; body?: unknown } | (() => { status?: number; body?: unknown });

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export function installFetchRouter(routes: Record<string, Answer>) {
  const calls: RecordedCall[] = [];
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const answer = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (answer === undefined)
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url.pathname}` }), { status: 599 });
    const { status = 200, body: payload = {} } = typeof answer === "function" ? answer() : answer;
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  });
  globalThis.fetch = fetchMock as never;
  return { calls, routes, fetchMock };
}
