"use client";

import { useRef, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Windowed table rows for the workbench's long lists (hundreds of topics or
 * groups). Only the rows in view (plus a margin) are in the DOM; spacer rows
 * above and below keep the scrollbar honest and the columns aligned, so the
 * table stays a real `<table>` with its header sticky over the scroll box.
 */

/** Fixed row height: the rows are one line each, so no per-row measuring. */
export const VIRTUAL_ROW_HEIGHT = 33;

export function useVirtualRows(count: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // react(incompatible-library) is a property of @tanstack/react-virtual (its
  // returned functions cannot be memoized by the compiler), the ResultsGrid
  // ruling; scoped to this call.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => VIRTUAL_ROW_HEIGHT,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = items.length === 0 ? 0 : virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  return { scrollRef, items, paddingTop, paddingBottom };
}

/** An empty spacer row standing in for the rows scrolled out of view. */
export function SpacerRow({ height, columns }: { height: number; columns: number }) {
  if (height <= 0) return null;
  return (
    <tr aria-hidden="true" style={{ height }}>
      {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- an empty spacer, hidden from assistive tech with its row */}
      <td colSpan={columns} />
    </tr>
  );
}

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  readonly key: K;
  readonly direction: SortDirection;
}

/** Same key flips the direction; a new key starts ascending. */
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/**
 * A column header that sorts: a button inside the `th`, with `aria-sort` on
 * the `th`. Every sortable column carries an arrow (faded until active), so
 * which columns sort is visible before anyone clicks.
 */
export function SortableHead<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  title,
}: {
  label: ReactNode;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sort.key === sortKey;
  const Arrow = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right")}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 hover:text-fg", align === "right" && "flex-row-reverse")}
      >
        {label}
        <Arrow strokeWidth={1.5} className={cn("w-3 h-3", !active && "opacity-40")} aria-hidden="true" />
      </button>
    </TableHead>
  );
}

/** A measured number's cell content: a shimmer while pending, "—" with the reason on error. */
export function MeasuredValue({ measured }: { measured: { value: number | null; error: string | null } | undefined }) {
  if (measured === undefined) {
    return (
      <span
        data-testid="kafka-measure-pending"
        aria-label="Loading"
        className="inline-block h-3 w-10 rounded bg-muted animate-pulse align-middle"
      />
    );
  }
  if (measured.value === null) return <span title={measured.error ?? undefined}>—</span>;
  return <>{measured.value}</>;
}
