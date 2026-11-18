"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readResourceConnectionCatalog } from "./use-resource-connections";
import type { ResourceConnectionRow } from "@/storagebase/resources/types";

export interface ManagedResourceConnectionsState {
  /** The fork's preconfigured rows — config-only "managed" connections (D3). */
  connections: ResourceConnectionRow[];
  loading: boolean;
  error: string | null;
  /** Reads the list again (after an operator changed the seed file, say). */
  reload: () => void;
}

/** One frozen empty list, so a caller memoising on `connections` never sees "nothing" change. */
const NO_CONNECTIONS: ResourceConnectionRow[] = [];

/**
 * The preconfigured resource connections this viewer may use (StorageBase
 * fork), read from the same catalog route as the viewer's own rows and
 * filtered to the seed file's entries.
 *
 * Decision D3 dropped the legacy admin-managed connection store: `roles:` in
 * the fork seed file is the whole access model now, so a "managed" row is one
 * the seed file declares, marked `seeded: true` with the permission the roles
 * grant. They arrive with no credentials and are READ-ONLY from the UI — no
 * edit, duplicate or delete, only the seed file changes them. The hook keeps
 * the legacy name because the section pages' contract (list them after the
 * viewer's own, marked Managed) is unchanged.
 *
 * `connections` keeps its identity between renders until a read answers
 * something new, because `useResourceSection` memoises on it. A failed read
 * keeps the last good list and says why.
 */
export function useManagedResourceConnections(enabled = true): ManagedResourceConnectionsState {
  const [connections, setConnections] = useState<ResourceConnectionRow[]>(NO_CONNECTIONS);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const request = useMemo(() => ({ enabled, generation }), [enabled, generation]);

  useEffect(() => {
    if (!request.enabled) return;
    let cancelled = false;
    const read = async () => {
      setLoading(true);
      try {
        const catalog = await readResourceConnectionCatalog();
        if (cancelled) return;
        const seeded = catalog.connections.filter((conn) => conn.seeded === true);
        setConnections(seeded.length === 0 ? NO_CONNECTIONS : seeded);
        setError(null);
      } catch {
        if (!cancelled) setError("Managed connections could not be loaded");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const reload = useCallback(() => setGeneration((current) => current + 1), []);
  return { connections, loading: enabled && loading, error, reload };
}
