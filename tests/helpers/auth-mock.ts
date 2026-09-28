import { mock } from "bun:test";

/**
 * One `@/lib/auth` double for the access-model and Entra tests (StorageBase fork), instead of a
 * sixth hand-copied stub (docs/BACKLOG.md D85). It carries every export the real module has, so an
 * importer of any of them loads, and it reads the session and records `login` through what the test
 * passes in. Call it before importing the module under test.
 */
export function installAuthMock(
  options: { getSession?: () => unknown; login?: (...args: unknown[]) => Promise<void> } = {},
): void {
  mock.module("@/lib/auth", () => ({
    getSession: mock(async () => options.getSession?.() ?? null),
    login: options.login ?? mock(async () => {}),
    logout: mock(async () => {}),
    signJWT: mock(async () => "token"),
    verifyJWT: mock(async () => null),
    shouldMarkCookieSecure: mock(async () => false),
    resetCookieSecurityWarning: mock(() => {}),
  }));
}
