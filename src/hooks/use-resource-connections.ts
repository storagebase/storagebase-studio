"use client";

import { useState, useEffect, useCallback } from "react";
import type { ResourceConnection } from "@/lib/resources/types";
import { storage } from "@/lib/storage";
import { forgetServerHeldConnection } from "@/lib/user-connections/client";

/**
 * The viewer's own resource connections, every category — the parallel of the
 * connection half of `useConnectionManager`, minus what this surface does not
 * need: no seeds, no catalog reads, no polling (the tree reads itself).
 *
 * It holds the list and nothing about selection: each section page picks and
 * remembers its own active connection (`useResourceSection`), so one store
 * serves four pages without one page's choice leaking into another's.
 */
export function useResourceConnections(storageReady = false) {
  const [connections, setConnections] = useState<ResourceConnection[]>([]);

  // The database manager's initializer shape: the writes land after the read
  // resolves, never synchronously in the effect body.
  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    const initialize = async () => {
      const loaded = storage.getResourceConnections();
      if (cancelled) return;
      setConnections(loaded);
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [storageReady]);

  const saveResourceConnection = useCallback((conn: ResourceConnection) => {
    storage.saveResourceConnection(conn);
    setConnections(storage.getResourceConnections());
  }, []);

  const deleteResourceConnection = useCallback((id: string) => {
    const deleted = storage.getResourceConnections().find((conn) => conn.id === id);
    if (deleted) forgetServerHeldConnection("resource", deleted);
    storage.deleteResourceConnection(id);
    setConnections(storage.getResourceConnections());
  }, []);

  return { connections, saveResourceConnection, deleteResourceConnection };
}
