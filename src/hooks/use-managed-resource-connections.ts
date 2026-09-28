"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import type { ManagedResourceConnection } from "@/lib/resources/types";

export interface ManagedResourceConnectionsState {
  connections: ManagedResourceConnection[];
  loading: boolean;
  error: string | null;
  /** Reads the list again (after an administrator changed a binding, say). */
  reload: () => void;
}

/** One frozen empty list, so a caller memoising on `connections` never sees "nothing" change. */
const NO_CONNECTIONS: ManagedResourceConnection[] = [];

/**
 * The admin-managed resource connections this viewer may use (StorageBase fork), from
 * `GET /api/resources/managed`. The section pages list them after the viewer's own connections,
 * marked Managed, with no edit, duplicate or delete. They arrive with no credentials and no
 * address: a request names one by id (src/lib/resources/connection-body.ts) and the server
 * resolves it.
 *
 * `connections` keeps its identity between renders until a read answers something new, because
 * `useResourceSection` memoises on it. A failed read keeps the last good list and says why.
 */
export function useManagedResourceConnections(enabled = true): ManagedResourceConnectionsState {
  const [connections, setConnections] = useState<ManagedResourceConnection[]>(NO_CONNECTIONS);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // A reload is an event asking for a new synchronization: the switch and the reload count travel
  // together as the value the effect synchronizes against (the OverviewTab pattern).
  const request = useMemo(() => ({ enabled, generation }), [enabled, generation]);

  useEffect(() => {
    if (!request.enabled) return;
    let cancelled = false;
    const read = async () => {
      setLoading(true);
      try {
        const res = await appFetch("/api/resources/managed");
        const body = (await res.json().catch(() => ({}))) as {
          connections?: ManagedResourceConnection[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `Managed connections could not be loaded (${res.status})`);
        } else {
          const next = body.connections ?? [];
          setConnections(next.length === 0 ? NO_CONNECTIONS : next);
          setError(null);
        }
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
