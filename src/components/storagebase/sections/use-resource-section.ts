"use client";

import { useCallback, useMemo, useState } from "react";
import { RESOURCE_CATEGORY_OF, type ResourceCategory, type ResourceConnectionRow } from "@/storagebase/resources/types";
import type { SectionConnection } from "./connection-body";
import { useManagedResourceConnections } from "./use-managed-resource-connections";
import { useResourceConnections } from "./use-resource-connections";

/**
 * One section page's connections and its active one (StorageBase fork).
 *
 * The list is this category's rows from the connection catalog — the
 * viewer-deployment's stored rows first, then the seed file's preconfigured
 * ones (an id the viewer also owns is theirs, listed once).
 *
 * The active connection is DERIVED, never stored as an object, so it can never
 * point at a connection that is gone: the explicit pick, else the deep link
 * (`?connection=<id>`), else the one this section remembered, else the first.
 * Picking one remembers it per section in localStorage — a per-viewer
 * convenience, so every read and write tolerates storage that throws — and
 * writes it into the address bar, so the URL is always a deep link to what is
 * on screen.
 */
export function useResourceSection(category: ResourceCategory, requestedId: string | null = null) {
  const owned = useResourceConnections();
  const managed = useManagedResourceConnections();

  const connections = useMemo<ResourceConnectionRow[]>(() => {
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
    (conn: SectionConnection) => {
      setPickedId(conn.id);
      remember(category, conn.id);
      writeConnectionParam(conn.id);
    },
    [category],
  );

  const { save: saveConnection, deleteResourceConnection } = owned;

  /** Saving from the form makes the saved row the active one (a new one, or the one just edited). */
  const save = useCallback(
    async (conn: SectionConnection): Promise<ResourceConnectionRow | null> => {
      const saved = await saveConnection(conn);
      select(saved);
      return saved;
    },
    [saveConnection, select],
  );

  return {
    connections,
    active,
    select,
    save,
    remove: deleteResourceConnection,
    loading: owned.loading || managed.loading,
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
