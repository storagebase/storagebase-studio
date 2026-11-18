import "../setup-dom";
import React from "react";
import { CommunitySection } from "@/components/community-section";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

/**
 * Fork stub coverage (SEAMS.md S8c, decision D5): StorageBase Studio ships without social links, so
 * the login hero's community block renders nothing on both surfaces. `src/lib/social-links.ts`
 * stays in the tree untouched — it is upstream's inventory and the stub simply stops consuming it.
 */
describe("CommunitySection", () => {
  afterEach(() => {
    cleanup();
  });

  describe.each(["desktop", "mobile"] as const)("fork stub (%s variant)", (variant) => {
    test("renders nothing: no repository line, no social row", () => {
      const { container } = render(<CommunitySection variant={variant} />);
      expect(container.innerHTML).toBe("");
      expect(container.querySelectorAll("a").length).toBe(0);
    });
  });
});
