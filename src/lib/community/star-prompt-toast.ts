/**
 * Fork stub (SEAMS.md S8b, decision D5): StorageBase Studio ships without star prompts, so both
 * entry points are inert. The module keeps its names and signatures so no caller changes (P9: the
 * query paths keep calling `maybeInviteToStar` from inside their try blocks unmodified), and it can
 * still never throw into a query result that has already been fetched — the stub body is empty, so
 * the pre-stub non-throwing contract holds trivially and forever.
 */

export function showStarPromptToast(): void {}

export function maybeInviteToStar(): void {}
