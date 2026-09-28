"use client";

import { useCallback, useMemo, useState } from "react";
import { useResourceConnections } from "@/hooks/use-resource-connections";
import { useManagedResourceConnections } from "@/hooks/use-managed-resource-connections";
import { RESOURCE_CATEGORY_OF, type ResourceCategory, type ResourceConnection } from "@/lib/resources/types";

/**
 * One section page's connections and its active one (StorageBase fork).
 *
 * The list is the viewer's own connections of this category, then the
 * admin-managed ones (an id the viewer also owns is theirs, listed once).
 *
 * The active connection is DERIVED, never stored as an object, so it can
 * never point at a connection that is gone: the explicit pick, else the deep
 * link (`?connection=<id>`), else the one this section remembered, else the
 * first. Picking one remembers it per section in localStorage — a per-viewer
 * convenience, so every read and write tolerates storage that throws — and
 * writes it into the address bar, so the URL is always a deep link to what is
 * on screen.
 */
export function useResourceSection(
  category: ResourceCategory,
  storageReady: boolean,
  requestedId: string | null = null,
) {
  const owned = useResourceConnections(storageReady);
  const managed = useManagedResourceConnections();

  const connections = useMemo<ResourceConnection[]>(() => {
    const mine = owned.connections.filter((conn) => RESOURCE_CATEGORY_OF[conn.type] === category);
    const ownedIds = new Set(mine.map((conn) => conn.id));
    const theirs = managed.connections.filter(
      (conn) => RESOURCE_CATEGORY_OF[conn.type] === category && !ownedIds.has(conn.id),
    );
    return [...mine, ...theirs];
  }, [owned.connections, managed.connections, category]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  // Read once: the deep link and the remembered id are where the page STARTS.
  const [preferredIds] = useState(() => [requestedId, readRemembered(category)]);

  const active = useMemo(() => {
    for (const id of [pickedId, ...preferredIds]) {
      const found = id === null ? undefined : connections.find((conn) => conn.id === id);
      if (found) return found;
    }
    return connections[0] ?? null;
  }, [connections, pickedId, preferredIds]);

  const select = useCallback(
    (conn: ResourceConnection) => {
      setPickedId(conn.id);
      remember(category, conn.id);
      writeConnectionParam(conn.id);
    },
    [category],
  );

  const { saveResourceConnection, deleteResourceConnection } = owned;

  /** Saving from the form makes the saved connection the active one (a new one, or the one just edited). */
  const save = useCallback(
    (conn: ResourceConnection) => {
      saveResourceConnection(conn);
      select(conn);
    },
    [saveResourceConnection, select],
  );

  return {
    connections,
    active,
    select,
    save,
    remove: deleteResourceConnection,
    managedLoading: managed.loading,
    managedError: managed.error,
  };
}

function storageKey(category: ResourceCategory): string {
  return `storagebase.section.${category}.connection`;
}

function readRemembered(category: ResourceCategory): string | null {
  try {
    return localStorage.getItem(storageKey(category));
  } catch {
    // No window (the server render), or storage the browser refuses: nothing remembered.
    return null;
  }
}

function remember(category: ResourceCategory, id: string): void {
  try {
    localStorage.setItem(storageKey(category), id);
  } catch {
    // A convenience, not state: a browser that refuses storage just forgets.
  }
}

/** Replaces, never pushes: switching connections is not a navigation Back should step through. */
function writeConnectionParam(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("connection", id);
  window.history.replaceState(window.history.state, "", url);
}
