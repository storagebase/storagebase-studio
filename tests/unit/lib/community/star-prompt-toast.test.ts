import { describe, test, expect } from "bun:test";

/**
 * Fork stub coverage (SEAMS.md S8b, decision D5): StorageBase Studio ships without star prompts, so
 * both entry points are inert — no toast is ever shown, nothing is written to localStorage, and no
 * failure of the removed machinery can reach the query path that calls `maybeInviteToStar`. The
 * non-throwing contract of the pre-stub module still holds, now trivially and forever.
 */
import { maybeInviteToStar, showStarPromptToast } from "@/lib/community/star-prompt-toast";

describe("the fork's star-prompt stub", () => {
  test("showStarPromptToast never shows a toast", () => {
    showStarPromptToast();

    expect(globalThis).not.toHaveProperty("sonner");
    expect(localStorage.length).toBe(0);
  });

  test("maybeInviteToStar is a no-op whatever the recorded history says", () => {
    localStorage.setItem("libredb_star_prompt_query_count", "9999");
    localStorage.setItem("libredb_star_prompt_handled", "");

    expect(() => maybeInviteToStar()).not.toThrow();

    // The stub counts nothing and marks nothing: the keys above keep whatever the caller wrote.
    expect(localStorage.getItem("libredb_star_prompt_query_count")).toBe("9999");
    expect(localStorage.getItem("libredb_star_prompt_handled")).toBe("");
  });
});
