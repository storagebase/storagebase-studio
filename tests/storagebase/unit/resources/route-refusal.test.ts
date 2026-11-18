import { describe, test, expect } from "bun:test";
import { routeRefusal } from "@/components/storagebase/resources/route-refusal";

const answer = (body: string, status = 502) => new Response(body, { status });

describe("routeRefusal", () => {
  test("reads the route's { error }, then the older { message }, then falls back", async () => {
    expect(await routeRefusal(answer(JSON.stringify({ error: "connect failed", message: "older" })), "x")).toBe(
      "connect failed",
    );
    expect(await routeRefusal(answer(JSON.stringify({ message: "older" })), "x")).toBe("older");
    expect(await routeRefusal(answer(JSON.stringify({ error: 42 })), "fallback")).toBe("fallback");
    expect(await routeRefusal(answer("<html>bad gateway</html>"), "fallback")).toBe("fallback");
    expect(await routeRefusal(answer("null"), "fallback")).toBe("fallback");
  });

  test("a fork refusal's SB_* code reaches the caller as the error sentence", async () => {
    const body = JSON.stringify({
      error: "Server storage is not enabled",
      code: "SB_STORE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(await routeRefusal(new Response(body, { status: 503 }), "fallback")).toBe("Server storage is not enabled");
  });
});
