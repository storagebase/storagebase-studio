import "../../setup-dom";

import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

// The pane imports the real viewer barrels (self-registration, like
// production); the completeness test below pins every type to a viewer.
import { ResourceViewerPane } from "@/components/resources/ResourceViewerPane";
import { hasResourceViewer } from "@/components/resources/viewer-registry";
import { RESOURCE_CATEGORY_OF, RESOURCE_TYPES } from "@/lib/resources/types";
import type { ResourceConnection, ResourceNode } from "@/lib/resources/types";

const queue: ResourceConnection = { id: "q1", name: "jobs", type: "sqs", createdAt: "2026-01-01T00:00:00.000Z" };
const queueNode: ResourceNode = { id: "queue/jobs", parentId: null, kind: "queue", name: "jobs", hasChildren: false };

describe("ResourceViewerPane", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("renders the type's registered viewer full-page, passing read-only and the callbacks through", async () => {
    mockGlobalFetch({ "api/resources/message/browse": { json: { messages: [], truncated: false } } });
    const onClose = mock(() => {});
    render(<ResourceViewerPane connection={queue} node={queueNode} readOnly onChanged={() => {}} onClose={onClose} />);
    expect(screen.getByTestId("resource-viewer-pane").contains(screen.getByTestId("message-viewer"))).toBe(true);
    await waitFor(() => screen.getByText("No messages."));
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("every tree-browsed resource type resolves a viewer — getResourceViewer never misses", () => {
    // A miss throws instead of rendering nothing, so this fails when a family
    // forgets a registration. RESOURCE_TYPES is the union's only list; the
    // vault types open their workbench and never reach the pane.
    for (const type of RESOURCE_TYPES.filter((candidate) => RESOURCE_CATEGORY_OF[candidate] !== "vault")) {
      expect(hasResourceViewer(type), type).toBe(true);
    }
  });
});
