"use client";

import type { ServerHeldSecrets } from "@/lib/user-connections/use-server-held-secrets";

/**
 * Under a secret input of a connection whose credentials the server holds (StorageBase fork):
 * says a value is saved without showing any of it, and offers the explicit removal that a blank
 * field cannot express (blank keeps).
 */
export function SavedSecretNote({ secrets, path }: { secrets: ServerHeldSecrets; path: string }) {
  if (secrets.isCleared(path)) {
    return (
      <p className="flex items-center gap-2 text-xs text-warning" data-testid={`saved-secret-${path}`}>
        Removed when you save.
        <button type="button" className="underline" onClick={() => secrets.toggleCleared(path)}>
          Undo
        </button>
      </p>
    );
  }
  if (!secrets.isSaved(path)) return null;
  return (
    <p className="flex items-center gap-2 text-xs text-fg-muted" data-testid={`saved-secret-${path}`}>
      •••• saved — leave blank to keep
      <button type="button" className="underline" onClick={() => secrets.toggleCleared(path)}>
        Clear
      </button>
    </p>
  );
}

/**
 * Where the credentials typed into this form will live. With server storage they are sealed on the
 * server and never sent back; without it they stay in this browser, which the user must know.
 */
export function CredentialStorageNotice({ secrets }: { secrets: ServerHeldSecrets }) {
  if (secrets.mode === null) return null;
  if (secrets.holdOnServer) {
    return (
      <p className="text-xs text-fg-muted" data-testid="credential-storage-notice" data-mode="server">
        Credentials are stored encrypted on the server and are never sent back to the browser. Changing the address
        clears them — enter them again.
      </p>
    );
  }
  return (
    <p className="text-xs text-warning" data-testid="credential-storage-notice" data-mode="browser">
      This deployment has no server storage: credentials are kept in this browser.
    </p>
  );
}
