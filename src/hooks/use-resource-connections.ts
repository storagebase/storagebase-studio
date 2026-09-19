"use client";

import { useState, useEffect, useCallback } from "react";
import type { ResourceConnection } from "@/lib/resources/types";
import { storage } from "@/lib/storage";

/**
 * Resource connection state for the shell — the parallel of the connection
 * half of `useConnectionManager`, minus what this surface does not need yet.
 *
 * No seeds, no catalog reads, no polling: the tree reads itself, and there is
 * no persisted active id (no `active_resource_connection_id` key exists), so
 * the first stored connection activates on load and selection after that is
 * explicit. Revisit when a workflow needs the active resource to survive a
 * refresh.
 */
export function useResourceConnections(storageReady = false) {
  const [connections, setConnections] = useState<ResourceConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<ResourceConnection | null>(null);

  // The database manager's initializer shape: the writes land after the read
  // resolves, never synchronously in the effect body.
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    const initialize = async () => {
      const loaded = storage.getResourceConnections();
      if (cancelled) return;
      setConnections(loaded);
      if (loaded.length > 0) {
        setActiveConnection(loaded[0]);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [storageReady]);

  const saveResourceConnection = useCallback((conn: ResourceConnection) => {
    storage.saveResourceConnection(conn);
    setConnections(storage.getResourceConnections());
    setActiveConnection(conn);
  }, []);

  const deleteResourceConnection = useCallback((id: string) => {
    storage.deleteResourceConnection(id);
    const rest = storage.getResourceConnections();
    setConnections(rest);
    // Never leave the tree mounted on a connection that no longer exists (the
    // D31 ruling, applied here): fall back to the first survivor, if any.
    setActiveConnection((prev) => (prev?.id === id ? (rest[0] ?? null) : prev));
  }, []);

  return {
    connections,
    activeConnection,
    setActiveConnection,
    saveResourceConnection,
    deleteResourceConnection,
  };
}
