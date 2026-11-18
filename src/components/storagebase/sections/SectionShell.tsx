import type React from "react";
import { SectionRail } from "./SectionRail";

/**
 * The standalone app shell (StorageBase fork): the section rail beside (below
 * the breakpoint, above) whichever management page is open. It is not part of
 * the embeddable library — the workspace has no routes to switch between.
 *
 * The page slot sizes its child to the space the rail leaves. The Databases
 * page is the upstream studio, whose root declares a full-viewport `h-screen`
 * of its own; `[&>*]:h-full!` overrides that one declaration from here, so
 * the studio fits beside the rail without a fork edit to hold its height.
 *
 * S1 on `src/app/page.tsx` imports this same shell as `StorageBaseShell`, so
 * the rail sits beside the studio on `/` with no change to upstream's page
 * beyond the two-line seam.
 */
export function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-canvas md:flex-row">
      <SectionRail />
      <div data-testid="section-page" className="relative flex min-h-0 min-w-0 flex-1 [&>*]:h-full!">
        {children}
      </div>
    </div>
  );
}
