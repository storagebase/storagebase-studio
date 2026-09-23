"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Small pieces the workbench panels share. Tabs are plain buttons, not the
 * Radix tabs primitive: the panels switch on local state and the rows need
 * nothing Radix adds (roving focus across three buttons is not worth a
 * pointer-event dance in every test).
 */

export function SectionTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-1 border-b border-hairline">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
          className={cn(
            "px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
            tab.id === active ? "border-brand-solid text-fg" : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-muted-foreground">
      <LoaderCircle strokeWidth={1.5} className="w-4 h-4 animate-spin" />
      <span className="text-xs">{label}</span>
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="text-xs text-danger leading-relaxed break-words">
      {error}
    </p>
  );
}

export function Notice({ notice }: { notice: string | null }) {
  if (notice === null) return null;
  return <output className="block text-xs text-success">{notice}</output>;
}

export const fieldClass = "h-8 bg-panel border-hairline focus:border-brand-tint/50 text-xs";

export const selectClass =
  "h-8 rounded-md bg-panel border border-hairline focus:border-brand-tint/50 text-xs text-fg-secondary px-2";

export const textareaClass =
  "w-full rounded-md bg-panel border border-hairline focus:border-brand-tint/50 text-xs font-mono text-fg-secondary p-2 resize-y placeholder:text-fg-subtle";

/**
 * A destructive action confirmed by typing the resource's name — the
 * kafbat/GitHub shape for deletes that cannot be undone. The route checks
 * the typed name again; this is the human half of the same rule.
 */
export function ConfirmByName({
  name,
  action,
  consequence,
  disabledReason,
  onConfirm,
}: {
  name: string;
  action: string;
  consequence: string;
  /** When set, the action is refused up front and this sentence says why. */
  disabledReason?: string | null;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-xs text-danger border-danger-tint/30"
        disabled={!!disabledReason}
        title={disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      >
        {action}
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-danger-tint/40 bg-panel p-3 space-y-2 max-w-md">
      <p className="text-xs text-fg-secondary leading-relaxed">
        {consequence} Type <span className="font-mono text-fg">{name}</span> to confirm.
      </p>
      <Input
        aria-label={`Type ${name} to confirm`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className={fieldClass}
      />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="text-xs text-danger border-danger-tint/30"
          disabled={typed !== name || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {action}
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
