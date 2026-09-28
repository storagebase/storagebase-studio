"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { errorText } from "./kafka-api";

/**
 * Lazily measured numbers for list rows — topic message counts, group lag —
 * asked for only for the rows on screen. The listing answers from metadata
 * in one round trip; each number costs offset reads, so they are fetched for
 * what the viewer can see, batched, a few requests at a time, and cached for
 * the session per connection (a Refresh clears it).
 */

export interface Measured {
  readonly value: number | null;
  readonly error: string | null;
}

/** Names per request: a screenful, under the route's bound of 50. */
const MEASURE_BATCH_SIZE = 25;

/** Requests in flight at once per list. */
const MEASURE_CONCURRENCY = 2;

/** Quiet time after a scroll or filter before the visible rows are asked for. */
const MEASURE_DEBOUNCE_MS = 150;

/** Session cache: `<connection id>:<kind>` to name to its measurement. Survives remounts, not reloads. */
const sessionCache = new Map<string, Map<string, unknown>>();

function cacheFor<T>(key: string): Map<string, T> {
  let cache = sessionCache.get(key);
  if (cache === undefined) {
    cache = new Map();
    sessionCache.set(key, cache);
  }
  return cache as Map<string, T>;
}

export function clearMeasureCacheForTest(): void {
  sessionCache.clear();
}

/**
 * `measure` answers one batch keyed by name; a name missing from the answer
 * and every name of a failed request are recorded as `failed(reason)` rather
 * than retried in a loop. Returns:
 * - `lookup` — a new function whenever a batch settles;
 * - `want(names)` — the names currently rendered, asked for first;
 * - `sweep(names | null)` — every name a sort needs, asked for after the
 *   rendered ones through the same bounded batches (null stops the sweep);
 * - `reset` — forgets this list's cache and asks again.
 */
export function useLazyMeasure<T>(
  cacheKey: string,
  measure: (names: string[]) => Promise<Record<string, T>>,
  failed: (reason: string) => T,
) {
  const [version, bump] = useReducer((count: number) => count + 1, 0);
  const inFlight = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = useRef<readonly string[]>([]);
  const sweeping = useRef<readonly string[]>([]);
  const mounted = useRef(true);
  const measureRef = useRef(measure);
  const failedRef = useRef(failed);
  const pumpRef = useRef(() => {});

  useEffect(() => {
    measureRef.current = measure;
    failedRef.current = failed;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const pump = useCallback(() => {
    while (active.current < MEASURE_CONCURRENCY && queue.current.length > 0) {
      const batch = queue.current.splice(0, MEASURE_BATCH_SIZE);
      const cache = cacheFor<T>(cacheKey);
      for (const name of batch) inFlight.current.add(name);
      active.current += 1;
      measureRef
        .current(batch)
        .then(
          (answer) => {
            for (const name of batch) cache.set(name, answer[name] ?? failedRef.current("not measured"));
          },
          (error: unknown) => {
            const reason = errorText(error);
            for (const name of batch) cache.set(name, failedRef.current(reason));
          },
        )
        .finally(() => {
          active.current -= 1;
          for (const name of batch) inFlight.current.delete(name);
          if (mounted.current) {
            bump();
            // Through the ref, not the closed-over pump: this runs long after
            // its render, and a connection change by then must continue with
            // the current cache key (the measureRef/failedRef pattern).
            pumpRef.current();
          }
        });
    }
  }, [cacheKey]);

  useEffect(() => {
    pumpRef.current = pump;
  });

  // The queue is replaced, not appended to: rows scrolled past before their
  // turn are not worth a request any more. Rendered rows go first, then the sweep.
  const schedule = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const cache = cacheFor<T>(cacheKey);
      queue.current = [...new Set([...wanted.current, ...sweeping.current])].filter(
        (name) => !cache.has(name) && !inFlight.current.has(name),
      );
      pump();
    }, MEASURE_DEBOUNCE_MS);
  }, [cacheKey, pump]);

  const want = useCallback(
    (names: readonly string[]) => {
      wanted.current = names;
      schedule();
    },
    [schedule],
  );

  const sweep = useCallback(
    (names: readonly string[] | null) => {
      sweeping.current = names ?? [];
      schedule();
    },
    [schedule],
  );

  const lookup = useCallback(
    (name: string): T | undefined => cacheFor<T>(cacheKey).get(name),
    // `version` is the cache's change counter: a new lookup per settled batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheKey, version],
  );

  // A batch still in flight lands in the forgotten map, never the fresh one.
  const reset = useCallback(() => {
    sessionCache.delete(cacheKey);
    bump();
    schedule();
  }, [cacheKey, schedule]);

  return { lookup, want, sweep, reset };
}
