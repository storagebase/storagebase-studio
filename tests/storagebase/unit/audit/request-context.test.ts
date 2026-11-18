import { describe, test, expect, afterEach } from "bun:test";
import { storagebaseRequestContext } from "@/storagebase/audit/request-context";

/**
 * Where a fork-route request came from, as the fork audit event records it. The same terms as the
 * old fork's audit-request tests (driven there through query-audit and resource-audit): the
 * resolved address, the forwarded chain only while TRUST_PROXY_HEADERS is on, and the user agent.
 */

const savedTrust = process.env.TRUST_PROXY_HEADERS;

function request(headers: Record<string, string> = {}): { headers: Headers } {
  return { headers: new Headers(headers) };
}

afterEach(() => {
  if (savedTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = savedTrust;
});

describe("storagebaseRequestContext", () => {
  test("records the resolved address, the raw chain and the user agent when proxy trust is on", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    expect(
      storagebaseRequestContext(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.2", "user-agent": "Mozilla/5.0" })),
    ).toEqual({ ip: "203.0.113.9", forwardedFor: "203.0.113.9, 10.0.0.2", userAgent: "Mozilla/5.0" });
  });

  test("with proxy trust off, neither the chain nor an address derived from it is recorded", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    expect(storagebaseRequestContext(request({ "x-forwarded-for": "203.0.113.9" }))).toEqual({});
  });

  test("an unusable address signal and absent headers record nothing", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    expect(storagebaseRequestContext(request())).toEqual({});
  });
});
