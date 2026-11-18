/**
 * The name S1 uses for the section shell on `/`. The shell itself lives once,
 * in SectionShell (the name the section pages and their tests use); this alias
 * keeps the seam's vocabulary about the product rather than the rail's
 * internals. No second implementation, so no second place to drift.
 */
export { SectionShell as StorageBaseShell } from "./SectionShell";
