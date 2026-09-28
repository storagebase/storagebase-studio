"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  DEFAULT_KEY_LIMIT,
  MAX_KEY_LIMIT,
  MAX_META_KEYS,
  sessionDatabase as sessionDatabaseOf,
  type KeyMeta,
  type RedisKeyTypeFilter,
} from "@/lib/redis-keys/scan";
import type { DatabaseConnection } from "@/lib/types";
import { fetchDatabases, fetchKeyMeta, fetchKeyPage } from "./redis-keys-api";

/**
 * The key browser's state (StorageBase fork): the loaded key names for one database, the cursor
 * to resume from, the numbered databases, and a metadata cache for the keys on screen.
 *
 * It lives in the dock rather than the panel, so closing and reopening the panel keeps what was
 * loaded and what was typed. Every state write happens after an await or in an event handler.
 */

/** The most keys the browser holds at once; the search stays one pass per keystroke under it. */
export const MAX_LOADED_KEYS = 50_000;

/** Quiet time after a scroll or filter before the visible keys' metadata is asked for. */
const META_DEBOUNCE_MS = 200;

export interface KeySet {
  readonly database: number;
  /** The MATCH this set was scanned with; absent is every key. */
  readonly match?: string;
  readonly type?: RedisKeyTypeFilter;
  readonly keys: readonly string[];
  readonly cursor: string;
  /** SCAN has returned to cursor "0": every key in the database (under match/type) is loaded. */
  readonly complete: boolean;
  /** The last page stopped on the server's deadline rather than its key cap. */
  readonly deadlineHit: boolean;
}

export interface DatabaseList {
  readonly databases: readonly number[];
  /** The database the editor's session runs in: values open there. */
  readonly sessionDatabase: number;
  /** Why the list could not be read; the selector then offers the session database alone. */
  readonly error?: string;
}

type Busy = "page" | "all" | null;

interface State {
  readonly set: KeySet | null;
  readonly busy: Busy;
  readonly error: string | null;
}

type Action =
  | { type: "start"; busy: Exclude<Busy, null> }
  | { type: "page"; set: KeySet }
  | { type: "done" }
  | { type: "failed"; error: string };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "start":
      return { ...state, busy: action.busy, error: null };
    case "page":
      return { ...state, set: action.set };
    case "done":
      return { ...state, busy: null };
    case "failed":
      return { ...state, busy: null, error: action.error };
  }
}

function merge(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const key of incoming) {
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(key);
    }
  }
  return merged;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ScanScope {
  readonly database: number;
  readonly match?: string;
  readonly type?: RedisKeyTypeFilter;
}

export function useRedisKeyBrowser(connection: DatabaseConnection) {
  const [state, dispatch] = useReducer(reduce, { set: null, busy: null, error: null });
  const [databases, setDatabases] = useState<DatabaseList | null>(null);
  const controller = useRef<AbortController | null>(null);
  const setRef = useRef<KeySet | null>(null);

  const metaCache = useRef(new Map<string, KeyMeta>());
  const metaInFlight = useRef(new Set<string>());
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [metaVersion, bumpMeta] = useReducer((count: number) => count + 1, 0);

  useEffect(
    () => () => {
      controller.current?.abort();
      if (metaTimer.current !== null) clearTimeout(metaTimer.current);
    },
    [],
  );

  const begin = (busy: Exclude<Busy, null>): AbortSignal => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    dispatch({ type: "start", busy });
    return next.signal;
  };

  const publish = (set: KeySet) => {
    setRef.current = set;
    dispatch({ type: "page", set });
  };

  /** One page after `from` (null starts the scope over). Answers whether more remain. */
  const page = async (scope: ScanScope, from: KeySet | null, limit: number, signal: AbortSignal): Promise<KeySet> => {
    const result = await fetchKeyPage(
      connection,
      { database: scope.database, cursor: from?.cursor ?? "0", match: scope.match, type: scope.type, limit },
      signal,
    );
    const set: KeySet = {
      database: scope.database,
      ...(scope.match !== undefined ? { match: scope.match } : {}),
      ...(scope.type !== undefined ? { type: scope.type } : {}),
      keys: merge(from?.keys ?? [], result.keys),
      cursor: result.cursor,
      complete: !result.truncated,
      deadlineHit: result.stoppedBy === "deadline",
    };
    publish(set);
    return set;
  };

  const run = async (busy: Exclude<Busy, null>, work: (signal: AbortSignal) => Promise<void>) => {
    const signal = begin(busy);
    try {
      await work(signal);
      dispatch({ type: "done" });
    } catch (error) {
      if (isAbort(error)) return;
      dispatch({ type: "failed", error: messageOf(error) });
    }
  };

  const loadDatabases = useCallback(async () => {
    const fallback = sessionDatabaseOf(connection.database);
    try {
      const containers = await fetchDatabases(connection);
      const numbers = containers.map((container) => Number(container.name)).filter(Number.isSafeInteger);
      const session = containers.find((container) => container.isSessionDefault);
      setDatabases({
        databases: numbers.length > 0 ? numbers : [fallback],
        sessionDatabase: session !== undefined ? Number(session.name) : fallback,
      });
    } catch (error) {
      setDatabases({ databases: [fallback], sessionDatabase: fallback, error: messageOf(error) });
    }
  }, [connection]);

  /** Starts a scope over: the first page of `scope`, replacing what is loaded. */
  const open = (scope: ScanScope) =>
    run("page", async (signal) => {
      metaCache.current.clear();
      await page(scope, null, DEFAULT_KEY_LIMIT, signal);
    });

  const remaining = (set: KeySet) => MAX_LOADED_KEYS - set.keys.length;

  const loadMore = () => {
    const from = setRef.current;
    if (from === null || from.complete || remaining(from) <= 0) return Promise.resolve();
    return run("page", async (signal) => {
      await page(from, from, Math.min(DEFAULT_KEY_LIMIT, remaining(from)), signal);
    });
  };

  /** Pages until the scope is complete or the browser holds MAX_LOADED_KEYS; Stop cancels. */
  const scanAll = () => {
    const start = setRef.current;
    if (start === null || start.complete) return Promise.resolve();
    return run("all", async (signal) => {
      let from = start;
      while (!from.complete && remaining(from) > 0) {
        from = await page(from, from, Math.min(MAX_KEY_LIMIT, remaining(from)), signal);
      }
    });
  };

  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    dispatch({ type: "done" });
  };

  /** Asks for the metadata of the keys on screen, debounced, cached per loaded set. */
  const wantMeta = useCallback(
    (keys: readonly string[]) => {
      if (metaTimer.current !== null) clearTimeout(metaTimer.current);
      metaTimer.current = setTimeout(() => {
        metaTimer.current = null;
        const set = setRef.current;
        if (set === null) return;
        const missing = keys
          .filter((key) => !metaCache.current.has(key) && !metaInFlight.current.has(key))
          .slice(0, MAX_META_KEYS);
        if (missing.length === 0) return;
        for (const key of missing) metaInFlight.current.add(key);
        fetchKeyMeta(connection, set.database, missing)
          .then(
            (entries) => {
              if (setRef.current?.database !== set.database) return;
              for (const entry of entries) metaCache.current.set(entry.key, entry);
            },
            () => {
              // Metadata is decoration: a failed batch leaves those rows without it.
            },
          )
          .finally(() => {
            for (const key of missing) metaInFlight.current.delete(key);
            bumpMeta();
          });
      }, META_DEBOUNCE_MS);
    },
    [connection],
  );

  const metaFor = useCallback(
    (key: string): KeyMeta | undefined => metaCache.current.get(key),
    // `metaVersion` is the cache's change counter: a new lookup per settled batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metaVersion],
  );

  /** The key's type, from the cache or one metadata read. */
  const typeOf = async (key: string): Promise<string | undefined> => {
    const cached = metaCache.current.get(key)?.type;
    const set = setRef.current;
    if (cached !== undefined || set === null) return cached;
    try {
      const [entry] = await fetchKeyMeta(connection, set.database, [key]);
      if (entry !== undefined) metaCache.current.set(key, entry);
      return entry?.type;
    } catch {
      return undefined;
    }
  };

  return {
    set: state.set,
    busy: state.busy,
    error: state.error,
    databases,
    loadDatabases,
    open,
    loadMore,
    scanAll,
    stop,
    wantMeta,
    metaFor,
    typeOf,
  };
}

export type RedisKeyBrowserState = ReturnType<typeof useRedisKeyBrowser>;
