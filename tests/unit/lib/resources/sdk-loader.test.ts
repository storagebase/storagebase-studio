import { describe, test, expect, mock } from "bun:test";
import { loadResourceSdk } from "@/lib/resources/sdk-loader";
import { ResourceConfigError } from "@/lib/resources/errors";

/**
 * The shared SDK loader is the one place provider load-failures are shaped,
 * so its three behaviors pin here once instead of once per provider: success
 * caches by specifier (the importer runs a single time), failure maps to
 * `ResourceConfigError` carrying the install hint, and distinct specifiers
 * do not share cache entries.
 */
describe("loadResourceSdk", () => {
  test("loads once and replays the cache", async () => {
    const importer = mock(async () => ({ connect: true }));
    const first = await loadResourceSdk<{ connect: boolean }>(
      "test:sdk-cache",
      "Cache SDK",
      "bun add cache-sdk",
      importer,
    );
    const second = await loadResourceSdk<{ connect: boolean }>(
      "test:sdk-cache",
      "Cache SDK",
      "bun add cache-sdk",
      importer,
    );
    expect(first).toEqual({ connect: true });
    expect(second).toBe(first);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  test("a loader that cannot load maps to a config error with the hint", async () => {
    const error = await loadResourceSdk("test:sdk-missing", "Missing SDK", "bun add missing-sdk", () =>
      Promise.reject(new Error("Cannot find module")),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceConfigError);
    expect((error as Error).message).toBe(
      "Missing SDK is not available in this environment. Install it with: bun add missing-sdk",
    );
  });

  test("distinct specifiers do not share cache entries", async () => {
    const first = await loadResourceSdk("test:sdk-a", "A", "bun add a", async () => ({ tag: "a" }));
    const second = await loadResourceSdk("test:sdk-b", "B", "bun add b", async () => ({ tag: "b" }));
    expect(first).toEqual({ tag: "a" });
    expect(second).toEqual({ tag: "b" });
  });
});
