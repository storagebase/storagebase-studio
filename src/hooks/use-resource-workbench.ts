"use client";

import { useCallback, useMemo, useState } from "react";
import { opensWorkbench } from "@/lib/resources/ui-config";
import type { ResourceConnection } from "@/lib/resources/types";
import type { useResourceConnections } from "@/hooks/use-resource-connections";

/**
 * The shell's split of resource connections (StorageBase fork): workbench
 * types (Kafka) list beside the database connections and open a full
 * workbench in the main area; every other type keeps the Resources section,
 * its sidebar tree and the inspector dialog.
 *
 * It wraps `useResourceConnections` rather than changing it — one store, one
 * save path — and owns only what the split adds: which workbench is open.
 * The open workbench is not persisted, the same ruling the active resource
 * connection follows.
 */
export function useResourceWorkbench(res: ReturnType<typeof useResourceConnections>) {
  const [activeWorkbench, setActiveWorkbench] = useState<ResourceConnection | null>(null);
  const { connections, activeConnection, deleteResourceConnection } = res;

  const treeConnections = useMemo(() => connections.filter((conn) => !opensWorkbench(conn.type)), [connections]);
  const workbenchConnections = useMemo(() => connections.filter((conn) => opensWorkbench(conn.type)), [connections]);
  // The tree never mounts on a workbench type: the first stored connection
  // activates on load, and a Kafka one would otherwise draw its topic tree.
  const activeTreeConnection = activeConnection && !opensWorkbench(activeConnection.type) ? activeConnection : null;

  const closeWorkbench = useCallback(() => setActiveWorkbench(null), []);

  /** After a save from the connection modal: a saved workbench connection opens (or refreshes) its workbench. */
  const handleSaved = useCallback((conn: ResourceConnection) => {
    if (opensWorkbench(conn.type)) setActiveWorkbench(conn);
  }, []);

  /** Delete through the one store, and never leave a workbench open on a connection that is gone. */
  const deleteConnection = useCallback(
    (id: string) => {
      deleteResourceConnection(id);
      setActiveWorkbench((prev) => (prev?.id === id ? null : prev));
    },
    [deleteResourceConnection],
  );

  return {
    treeConnections,
    activeTreeConnection,
    workbenchConnections,
    activeWorkbench,
    openWorkbench: setActiveWorkbench,
    closeWorkbench,
    handleSaved,
    deleteConnection,
  };
}
