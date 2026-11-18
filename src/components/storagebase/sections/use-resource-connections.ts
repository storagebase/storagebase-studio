"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { routeRefusal } from "@/components/storagebase/resources/route-refusal";
import { appFetch } from "@/lib/config/base-path";
import type { ResourceConnectionInput } from "@/storagebase/resources/connections";
import { RESOURCE_CONNECTION_FIELD_NAMES } from "@/storagebase/resources/ui-config";
import {
  isSeededResourceConnection,
  type ResourceConnection,
  type ResourceConnectionRow,
} from "@/storagebase/resources/types";

/**
 * The section pages' connection catalog (StorageBase fork). Unlike the legacy
 * hook, which read a browser-local store, every connection here lives behind
 * `/api/sb/resources/connections` (STORAGEBASE.md P3): the list merges the
 * deployment-wide fork-store records with the role-matched seed rows, and no
 * response ever carries a credential — only ids, non-secret fields and a
 * has-credential marker.
 *
 * The hook holds no selection: each section page picks and remembers its own
 * active row (`useResourceSection`), so one catalog serves three pages without
 * one page's choice leaking into another's.
 */
const STORED_ID_PREFIX = "res_";
const CATALOG_ROUTE = "/api/sb/resources/connections";

/** The list answer: the rows plus whether this deployment has a fork store at all. */
export interface ResourceConnectionCatalog {
  connections: ResourceConnectionRow[];
  storeAvailable: boolean;
}

/** One JSON POST to a fork connection route, with the server's refusal as the error. */
async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  const response = await appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await routeRefusal(response, "Resource connection request failed"));
  return response;
}

/** Reads the whole catalog, used by the hook and by the seeded-rows hook. */
export async function readResourceConnectionCatalog(): Promise<ResourceConnectionCatalog> {
  const response = await postJson(CATALOG_ROUTE, { action: "list" });
  const body = (await response.json().catch(() => null)) as {
    connections?: ResourceConnectionRow[];
    storeAvailable?: boolean;
  } | null;
  if (body === null || !Array.isArray(body.connections)) throw new Error("Connection list answer was malformed");
  return { connections: body.connections, storeAvailable: body.storeAvailable === true };
}

/** The whitelisted create/update body: the same field vocabulary the server's `readResourceConnectionInput` accepts. */
export function resourceConnectionInputOf(conn: ResourceConnection | ResourceConnectionRow): ResourceConnectionInput {
  const input: ResourceConnectionInput = { name: conn.name, type: conn.type };
  const record = conn as unknown as Record<string, unknown>;
  // The body is a wire shape, not a type: the server whitelists the fields it
  // knows, so a field added to the browser vocabulary ahead of the intake list
  // is harmless here and never becomes a stored value it did not ask for.
  const wire = input as unknown as Record<string, string>;
  for (const field of RESOURCE_CONNECTION_FIELD_NAMES) {
    const value = record[field];
    if (typeof value === "string" && value !== "") wire[field] = value;
  }
  return input;
}

function rowFrom(answer: unknown): ResourceConnectionRow {
  const body = answer as { connection?: ResourceConnectionRow } | null;
  if (body?.connection === undefined) throw new Error("Connection answer was malformed");
  return body.connection;
}

export function useResourceConnections(enabled = true) {
  const [connections, setConnections] = useState<ResourceConnectionRow[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [storeAvailable, setStoreAvailable] = useState(false);
  const [generation, setGeneration] = useState(0);
  // A reload is an event asking for a new synchronization: the switch and the
  // read count travel together as the value the effect synchronizes against.
  const request = useMemo(() => ({ enabled, generation }), [enabled, generation]);

  useEffect(() => {
    if (!request.enabled) return;
    let cancelled = false;
    const read = async () => {
      setLoading(true);
      try {
        const catalog = await readResourceConnectionCatalog();
        if (cancelled) return;
        setConnections(catalog.connections);
        setStoreAvailable(catalog.storeAvailable);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
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

  /** Create a new stored connection, or update an existing one; a seeded row is never writable here. */
  const save = useCallback(
    async (conn: ResourceConnection | ResourceConnectionRow): Promise<ResourceConnectionRow> => {
      if (isSeededResourceConnection(conn)) throw new Error("Preconfigured connections are read-only");
      const stored = conn.id.startsWith(STORED_ID_PREFIX);
      const path = stored ? `${CATALOG_ROUTE}/${encodeURIComponent(conn.id)}` : CATALOG_ROUTE;
      const action = stored ? "update" : "create";
      const response = await postJson(path, { action, connection: resourceConnectionInputOf(conn) });
      const row = rowFrom(await response.json().catch(() => null));
      reload();
      return row;
    },
    [reload],
  );

  /** Delete a stored connection; a seeded id belongs to the seed file, not to this button. */
  const deleteResourceConnection = useCallback(
    async (id: string): Promise<void> => {
      if (id.startsWith("seed:")) throw new Error("Preconfigured connections are read-only");
      await postJson(`${CATALOG_ROUTE}/${encodeURIComponent(id)}`, { action: "delete" });
      reload();
    },
    [reload],
  );

  return {
    connections,
    loading: enabled && loading,
    error,
    storeAvailable,
    reload,
    save,
    deleteResourceConnection,
  };
}
