"use client";

/**
 * Fork stub (SEAMS.md S8a, decision D5): StorageBase Studio ships without social or star links. The
 * module keeps its name and signature so no caller changes (P9: stub the leaf, never the callers —
 * the sidebar and both studio headers keep rendering it unmodified); it renders nothing, so the
 * CSP, air-gapped installs and the star-prompt key handling are all out of the picture for good.
 */

interface GitHubRepoLinkProps {
  /**
   * Spacing, sizing AND colour for the surrounding chrome — now inert: the stub renders nothing,
   * but the prop stays so the two caller surfaces compile unchanged.
   */
  className?: string;
}

export function GitHubRepoLink(props: GitHubRepoLinkProps) {
  void props; // fork stub: nothing renders (S8a, D5)
  return null;
}
