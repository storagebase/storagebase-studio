import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { useServerHeldSecrets } from "@/lib/user-connections/use-server-held-secrets";

/**
 * The connection forms' share of server-held credentials: clearing is an
 * explicit per-edit toggle (blank keeps), independent of what the server holds.
 */

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

function renderSecrets() {
  mockGlobalFetch({ "/api/storage/config": { json: { serverMode: true } } });
  return renderHook(() =>
    useServerHeldSecrets({
      kind: "database",
      // Stable identity across renders: the hook keys cleared paths on it.
      editConnection: EDIT_CONNECTION,
      isOpen: true,
      hostManaged: false,
    }),
  );
}

const EDIT_CONNECTION = { savedSecrets: ["password"] };

describe("useServerHeldSecrets clearing", () => {
  test("toggling a path arms and disarms its removal", async () => {
    const { result, unmount } = renderSecrets();
    await waitFor(() => expect(result.current.holdOnServer).toBe(true));
    expect(result.current.isCleared("password")).toBe(false);
    act(() => {
      result.current.toggleCleared("password");
    });
    expect(result.current.isCleared("password")).toBe(true);
    act(() => {
      result.current.toggleCleared("password");
    });
    expect(result.current.isCleared("password")).toBe(false);
    unmount();
  });

  test("an armed path is not reported as saved", async () => {
    const { result, unmount } = renderSecrets();
    await waitFor(() => expect(result.current.holdOnServer).toBe(true));
    expect(result.current.isSaved("password")).toBe(true);
    act(() => {
      result.current.toggleCleared("password");
    });
    expect(result.current.isSaved("password")).toBe(false);
    unmount();
  });
});
