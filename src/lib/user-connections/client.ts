"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import { readJSON, writeJSON } from "@/lib/storage/local-storage";
import { isServerHeld, type UserConnectionFamily } from "./ids";

/**
 * The browser half of server-held connection credentials (StorageBase fork). Everything the
 * connection forms, the storage sync and the delete paths need, so none of them builds these
 * requests itself. Nothing here ever reads a secret back: the server answers rows with
 * `savedSecrets` only.
 */

export type ConnectionStorageMode = "server" | "browser";

let modePromise: Promise<ConnectionStorageMode> | null = null;

/**
 * Where this deployment keeps a user's connections: `server` with STORAGE_PROVIDER=sqlite|postgres
 * (credentials write-only on the server), `browser` otherwise — and also when the config cannot be
 * read, because the answer decides where a secret is SENT and the browser is where it already is.
 */
export function readConnectionStorageMode(): Promise<ConnectionStorageMode> {
  modePromise ??= appFetch("/api/storage/config")
    .then(async (res) => (res.ok && (await res.json()).serverMode === true ? "server" : "browser"))
    .catch((): ConnectionStorageMode => "browser");
  return modePromise;
}

/** Forgets the memoized answer. For tests. */
export function resetConnectionStorageModeForTests(): void {
  modePromise = null;
}

/** The storage mode, or null until it is known. */
export function useConnectionStorageMode(enabled = true): ConnectionStorageMode | null {
  const [mode, setMode] = useState<ConnectionStorageMode | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readConnectionStorageMode().then((answer) => {
      if (!cancelled) setMode(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? mode : null;
}

/** A refusal the server explained, in its own words, for the form to show. */
export class UserConnectionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConnectionRequestError";
  }
}

async function post(path: string, body: unknown, method = "POST"): Promise<Response> {
  return appFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function refusal(res: Response): Promise<UserConnectionRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new UserConnectionRequestError(body.error || `The server refused the request (HTTP ${res.status})`);
}

/**
 * Saves a connection on the server and answers the copy the browser may keep: no secret, and
 * `savedSecrets` naming the ones the server now holds. `clear` names stored secrets to remove.
 */
export async function saveServerHeldConnection<T extends object>(
  kind: UserConnectionFamily,
  connection: T,
  clear: readonly string[] = [],
): Promise<T> {
  const res = await post("/api/connections/user", { kind, connection, clear });
  if (!res.ok) throw await refusal(res);
  return ((await res.json()) as { connection: T }).connection;
}

/** Tests an edited, server-held connection with the stored secrets filled in on the server. */
export async function testServerHeldConnection<T>(
  kind: UserConnectionFamily,
  connection: object,
  clear: readonly string[] = [],
): Promise<T> {
  const res = await post("/api/connections/user/test", { kind, connection, clear });
  return (await res.json()) as T;
}

/** Forgets a deleted connection's stored secrets. Best effort: an orphaned sealed record opens nothing. */
export function forgetServerHeldConnection(
  kind: UserConnectionFamily,
  conn: { id: string; savedSecrets?: unknown },
): void {
  if (!isServerHeld(conn)) return;
  post("/api/connections/user", { kind, id: conn.id }, "DELETE").catch(() => {
    /* best-effort cleanup */
  });
}

/**
 * The one-time move of this browser's connections into the server (run by the storage sync in
 * server mode, before it pulls): every stored row the server does not hold yet — which is every
 * row that may still carry a secret — is sent once, and the browser's collections are replaced by
 * the server's answer, which carries none. A browser with nothing left to move sends nothing, so
 * this is idempotent. Answers how many rows gave up secrets.
 */
export async function migrateBrowserConnections(): Promise<number> {
  const connections = (readJSON<object[]>("connections") ?? []).filter((row) => !isServerHeld(row));
  const resourceConnections = (readJSON<object[]>("resource_connections") ?? []).filter((row) => !isServerHeld(row));
  if (connections.length === 0 && resourceConnections.length === 0) return 0;
  const res = await post("/api/connections/user/migrate", { connections, resourceConnections });
  if (!res.ok) throw await refusal(res);
  const answer = (await res.json()) as { migrated: number; connections: object[]; resourceConnections: object[] };
  writeJSON("connections", answer.connections);
  writeJSON("resource_connections", answer.resourceConnections);
  return answer.migrated;
}
