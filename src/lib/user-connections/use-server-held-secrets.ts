"use client";

import { useCallback, useState } from "react";
import {
  saveServerHeldConnection,
  testServerHeldConnection,
  useConnectionStorageMode,
  type ConnectionStorageMode,
} from "./client";
import { isServerHeld, type UserConnectionFamily } from "./ids";

/**
 * The connection forms' share of server-held credentials (StorageBase fork), one hook for the
 * database form and the resource form so the two cannot disagree about when a secret leaves the
 * browser:
 *
 * - `holdOnServer`: the deployment has server storage and the form is Studio's own (an embedding
 *   host that passes its own test adapter keeps its connections itself, inline);
 * - a secret field of a connection the server holds starts EMPTY — the browser never had it — and
 *   `isSaved(path)` says a value is stored; blank keeps it, `toggleCleared(path)` removes it;
 * - `probe` tests an edit of a held connection through the server, which fills the stored secrets
 *   in; a new connection is tested inline, the one time its typed secrets travel before the save;
 * - `persist` saves on the server and hands the caller the copy it may keep, which has no secret.
 */
export interface ServerHeldSecrets {
  mode: ConnectionStorageMode | null;
  holdOnServer: boolean;
  isSaved(path: string): boolean;
  isCleared(path: string): boolean;
  toggleCleared(path: string): void;
  probe<T>(connection: object, inline: () => Promise<T>): Promise<T>;
  persist<C extends object>(connection: C): Promise<C>;
}

export function useServerHeldSecrets({
  kind,
  editConnection,
  isOpen,
  hostManaged,
}: {
  kind: UserConnectionFamily;
  editConnection: { savedSecrets?: string[] } | null | undefined;
  isOpen: boolean;
  /** The embedding host tests (and so keeps) the connections itself. */
  hostManaged: boolean;
}): ServerHeldSecrets {
  const mode = useConnectionStorageMode(!hostManaged);
  const holdOnServer = !hostManaged && mode === "server";
  const held = holdOnServer && !!editConnection && isServerHeld(editConnection);

  // Cleared paths belong to one edit of one connection in one opening of the dialog; derived
  // rather than reset in an effect, so the next dialog can never start with a pending removal.
  const [clearState, setClearState] = useState<{ conn: unknown; open: boolean; paths: string[] }>({
    conn: editConnection,
    open: isOpen,
    paths: [],
  });
  const cleared = clearState.conn === editConnection && clearState.open === isOpen ? clearState.paths : [];

  const toggleCleared = useCallback(
    (path: string) => {
      const next = cleared.includes(path) ? cleared.filter((p) => p !== path) : [...cleared, path];
      setClearState({ conn: editConnection, open: isOpen, paths: next });
    },
    [cleared, editConnection, isOpen],
  );

  const probe = useCallback(
    <T>(connection: object, inline: () => Promise<T>): Promise<T> =>
      held ? testServerHeldConnection<T>(kind, connection, cleared) : inline(),
    [cleared, held, kind],
  );

  const persist = useCallback(
    <C extends object>(connection: C): Promise<C> =>
      holdOnServer ? saveServerHeldConnection(kind, connection, cleared) : Promise.resolve(connection),
    [cleared, holdOnServer, kind],
  );

  return {
    mode,
    holdOnServer,
    isSaved: (path) => held && (editConnection?.savedSecrets ?? []).includes(path) && !cleared.includes(path),
    isCleared: (path) => cleared.includes(path),
    toggleCleared,
    probe,
    persist,
  };
}
