import { Database } from "lucide-react";

/** Shown instead of a tab's forms when the deployment has no server storage for the access model. */
export function StoreNotice({ message }: { message?: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-xl border border-warning-tint/30 bg-warning-tint/10 p-4 text-sm text-fg-secondary"
    >
      <Database className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <p>{message || "This needs server storage (STORAGE_PROVIDER=sqlite or postgres)."}</p>
    </div>
  );
}
