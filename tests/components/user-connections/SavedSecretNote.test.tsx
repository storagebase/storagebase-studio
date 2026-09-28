import "../../setup-dom";

import { describe, expect, mock, test, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CredentialStorageNotice, SavedSecretNote } from "@/components/user-connections/SavedSecretNote";
import type { ServerHeldSecrets } from "@/lib/user-connections/use-server-held-secrets";

/**
 * The note under a secret input of a server-held connection: what is saved is
 * named, never shown, and its removal is explicit (blank keeps).
 */

function secrets(overrides: Partial<ServerHeldSecrets> = {}): ServerHeldSecrets {
  return {
    mode: "server",
    holdOnServer: true,
    isSaved: () => false,
    isCleared: () => false,
    toggleCleared: mock(() => {}),
    probe: async (_connection: object, inline: () => Promise<never>) => inline(),
    persist: async <C extends object>(connection: C) => connection,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SavedSecretNote", () => {
  test("nothing renders for a path the server holds nothing for", () => {
    const { container } = render(<SavedSecretNote secrets={secrets()} path="password" />);
    expect(container.innerHTML).toBe("");
  });

  test("a saved value is named, never shown, and Clear arms its removal", () => {
    const toggleCleared = mock(() => {});
    render(<SavedSecretNote secrets={secrets({ isSaved: () => true, toggleCleared })} path="password" />);
    const note = screen.getByTestId("saved-secret-password");
    expect(note.textContent).toContain("saved");
    expect(note.textContent).not.toContain("pw-1");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(toggleCleared).toHaveBeenCalledWith("password");
  });

  test("an armed removal says so and offers Undo", () => {
    const toggleCleared = mock(() => {});
    render(<SavedSecretNote secrets={secrets({ isCleared: () => true, toggleCleared })} path="password" />);
    expect(screen.getByTestId("saved-secret-password").textContent).toContain("Removed when you save.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(toggleCleared).toHaveBeenCalledWith("password");
  });
});

describe("CredentialStorageNotice", () => {
  test("nothing renders while the mode is unknown", () => {
    const { container } = render(<CredentialStorageNotice secrets={secrets({ mode: null })} />);
    expect(container.innerHTML).toBe("");
  });

  test("server storage names the seal; browser storage warns it keeps secrets locally", () => {
    const { unmount } = render(<CredentialStorageNotice secrets={secrets({ mode: "server", holdOnServer: true })} />);
    expect(screen.getByTestId("credential-storage-notice").getAttribute("data-mode")).toBe("server");
    unmount();
    render(<CredentialStorageNotice secrets={secrets({ mode: "browser", holdOnServer: false })} />);
    const notice = screen.getByTestId("credential-storage-notice");
    expect(notice.getAttribute("data-mode")).toBe("browser");
    expect(notice.textContent).toContain("kept in this browser");
  });
});
