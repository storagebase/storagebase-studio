/**
 * The timers the fork's background work schedules with (StorageBase fork): the pair
 * src/storagebase/core/seams.ts pinned at its own load, when that module ran first, else this
 * process's own. Upstream imports the seams module before any test body runs, so the pinned pair is
 * the real one even after a test installs a fake clock (bun's `jest.useFakeTimers()`), which can
 * therefore never capture — or count among the timers it asserts it left behind — a fork flush or
 * a fork store's idle close. In production the two pairs are the same.
 */

export const PINNED_TIMERS_KEY = Symbol.for("storagebase.auditTimers");

export interface StoragebaseTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

type PinnedTimersHolder = { [PINNED_TIMERS_KEY]?: StoragebaseTimers };

export function storagebaseTimers(): StoragebaseTimers {
  return (globalThis as PinnedTimersHolder)[PINNED_TIMERS_KEY] ?? { setTimeout, clearTimeout };
}
