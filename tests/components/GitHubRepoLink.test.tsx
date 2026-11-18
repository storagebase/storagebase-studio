import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { GitHubRepoLink } from "@/components/github-repo-link";

/**
 * Fork stub coverage (SEAMS.md S8a, decision D5): StorageBase Studio ships without repository links,
 * so the leaf renders nothing on every surface that calls it — the sidebar and both studio headers
 * keep calling it unmodified (P9: stub the leaf, never the callers).
 */
describe("GitHubRepoLink", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders nothing, in both chrome surfaces it is called from", () => {
    const { container } = render(<GitHubRepoLink />);
    expect(container.innerHTML).toBe("");

    const darkChrome = render(<GitHubRepoLink className="text-zinc-400" />);
    expect(darkChrome.container.innerHTML).toBe("");
  });
});
