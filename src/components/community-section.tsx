/**
 * Fork stub (SEAMS.md S8c, decision D5): StorageBase Studio ships without social links, so the login
 * hero's social row renders nothing on both surfaces. The component keeps its name, props and export
 * so no caller changes (P9: stub the leaf, never the callers — `src/app/login/login-form.tsx` and
 * `src/components/login/database-showcase.tsx` keep rendering it unmodified).
 *
 * `src/lib/social-links.ts` stays in the tree, unreferenced from the app: it is upstream's inventory
 * and deleting it would be an upstream-file deletion the ledger does not carry.
 */

interface CommunitySectionProps {
  variant: "desktop" | "mobile";
}

export function CommunitySection(props: CommunitySectionProps) {
  void props; // fork stub: nothing renders (S8c, D5)
  return null;
}
