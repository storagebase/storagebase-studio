"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaConsumerGroupListing, KafkaConsumerGroupSummary, KafkaGroupLag } from "@/lib/resources/operations";
import { cn } from "@/lib/utils";
import { postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { useLazyMeasure } from "./use-lazy-measure";
import {
  MeasuredValue,
  nextSort,
  SortableHead,
  type SortState,
  SpacerRow,
  useVirtualRows,
  VIRTUAL_ROW_HEIGHT,
} from "./virtual-list";
import { ErrorLine, fieldClass, Loading, selectClass } from "./parts";

type GroupSortKey = "name" | "members" | "topics" | "lag" | "coordinator" | "state";

/** What one lag batch answers per group: lag and topic count come from the same committed offsets. */
interface GroupMeasure {
  readonly totalLag: number | null;
  readonly topics: number | null;
  readonly error: string | null;
}

type StateKind = "stable" | "rebalancing" | "empty" | "dead" | "unknown";

const STATE_FILTERS = [
  { id: "all", label: "All states" },
  { id: "stable", label: "Stable" },
  { id: "rebalancing", label: "Rebalancing" },
  { id: "empty", label: "Empty" },
  { id: "dead", label: "Dead" },
] as const;

type StateFilter = (typeof STATE_FILTERS)[number]["id"];

const STATE_BADGE: Record<StateKind, string> = {
  stable: "bg-success-tint/10 text-success",
  rebalancing: "bg-warning-tint/10 text-warning",
  empty: "bg-muted text-fg-muted",
  dead: "bg-danger-tint/10 text-danger",
  unknown: "bg-muted text-fg-subtle",
};

const COLUMNS = 6;

const unmeasured = (error: string): GroupMeasure => ({ totalLag: null, topics: null, error });

/** Kafka's state names (`PreparingRebalance`, …) by what they mean for the group; `AwaitingSync` is the pre-2.x name. */
function groupStateKind(state: string): StateKind {
  switch (state.replace(/[_\s]/g, "").toLowerCase()) {
    case "stable":
      return "stable";
    case "preparingrebalance":
    case "completingrebalance":
    case "awaitingsync":
      return "rebalancing";
    case "empty":
      return "empty";
    case "dead":
      return "dead";
    default:
      return "unknown";
  }
}

/** `PreparingRebalance` → `PREPARING_REBALANCE`, the protocol's spelling. */
function stateLabel(state: string): string {
  return (state === "" ? "Unknown" : state).replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Consumer groups, laid out like kafbat-ui's Consumers page: group id,
 * members, topics, lag, coordinator and state (a colored badge), every
 * column sortable, searchable by id and filterable by state. The studio's own
 * peek groups are internal: hidden unless asked for, the internal-topic ruling.
 *
 * The listing is state, members and coordinator (DescribeGroups plus one
 * metadata read); lag and topic count come from `groups/lag`, for the rows on
 * screen. Sorting by lag or topics has to be right over every group, so it
 * sweeps the whole filtered list through the same bounded batches — with
 * progress and a cancel — re-sorting as batches land, unmeasured groups last.
 */
export function KafkaGroupsPanel({
  connection,
  onOpenGroup,
}: {
  connection: ResourceConnection;
  onOpenGroup: (groupId: string) => void;
}) {
  const read = useCallback(() => postKafka<KafkaConsumerGroupListing>(connection, "groups"), [connection]);
  const { data: listing, error, reload: load } = useKafkaRead(read);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showInternal, setShowInternal] = useState(false);

  const measure = useCallback(
    async (groupIds: string[]): Promise<Record<string, GroupMeasure>> => {
      const { lags } = await postKafka<{ lags: Record<string, KafkaGroupLag> }>(connection, "groups/lag", {
        groupIds,
      });
      return Object.fromEntries(
        Object.entries(lags).map(([id, lag]) => [
          id,
          { totalLag: lag.totalLag, topics: lag.topics, error: lag.lagError },
        ]),
      );
    },
    [connection],
  );
  const { lookup, want, sweep, reset } = useLazyMeasure<GroupMeasure>(
    `${connection.id}:group-lag`,
    measure,
    unmeasured,
  );
  const refresh = useCallback(async () => {
    reset();
    await load();
  }, [reset, load]);

  const [sort, setSort] = useState<SortState<GroupSortKey>>({ key: "name", direction: "asc" });
  const [sweepStopped, setSweepStopped] = useState(false);
  const onSort = useCallback((key: GroupSortKey) => {
    setSort((current) => nextSort(current, key));
    setSweepStopped(false);
  }, []);
  const needle = useDeferredValue(search).trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (listing?.groups ?? []).filter(
        (group) =>
          (showInternal || !group.internal) &&
          (stateFilter === "all" || groupStateKind(group.state) === stateFilter) &&
          group.groupId.toLowerCase().includes(needle),
      ),
    [listing, showInternal, stateFilter, needle],
  );
  const measuredSort = sort.key === "lag" || sort.key === "topics";
  // Only the measured sorts depend on the lookup, so only they re-sort when a batch lands.
  const measureLookup = measuredSort ? lookup : null;
  const visible = useMemo(() => sortGroups(filtered, sort, measureLookup), [filtered, sort, measureLookup]);

  const sweepKey = measuredSort && !sweepStopped ? filtered.map((group) => group.groupId).join("\n") : "";
  useEffect(() => {
    sweep(sweepKey === "" ? null : sweepKey.split("\n"));
  }, [sweepKey, sweep]);
  const measuredCount = measuredSort ? filtered.filter((group) => lookup(group.groupId) !== undefined).length : 0;

  const { scrollRef, items, paddingTop, paddingBottom } = useVirtualRows(visible.length);
  const onScreenKey = items
    .map((item) => visible[item.index]?.groupId)
    .filter((id) => id !== undefined)
    .join("\n");
  useEffect(() => {
    if (onScreenKey !== "") want(onScreenKey.split("\n"));
  }, [onScreenKey, want]);

  return (
    <div data-testid="kafka-groups" className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search by Consumer Group ID"
          placeholder="Search by Consumer Group ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${fieldClass} w-64`}
        />
        <select
          aria-label="Filter by state"
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          className={selectClass}
        >
          {STATE_FILTERS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
          Show studio peek groups
        </label>
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => void refresh()}>
          <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      <ErrorLine error={error} />
      {measuredSort && measuredCount < filtered.length && (
        <output className="flex items-center gap-2 text-xs text-fg-muted">
          {sweepStopped ? (
            <>
              <span>
                Lag measured for {measuredCount}/{filtered.length} groups; unmeasured groups sort last.
              </span>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setSweepStopped(false)}>
                Resume
              </Button>
            </>
          ) : (
            <>
              <span>
                Measuring lag {measuredCount}/{filtered.length}…
              </span>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setSweepStopped(true)}>
                Cancel
              </Button>
            </>
          )}
        </output>
      )}
      {listing === null ? (
        error === null && <Loading label="Listing consumer groups…" />
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No consumer groups match.</p>
      ) : (
        <div ref={scrollRef} data-testid="kafka-groups-scroll" className="flex-1 min-h-64 overflow-auto">
          <table className="w-full caption-bottom text-xs" aria-rowcount={visible.length + 1}>
            <TableHeader className="sticky top-0 z-10 bg-surface">
              <TableRow aria-rowindex={1}>
                <SortableHead label="Group ID" sortKey="name" sort={sort} onSort={onSort} />
                <SortableHead label="Num of members" sortKey="members" sort={sort} onSort={onSort} align="right" />
                <SortableHead
                  label="Num of topics"
                  sortKey="topics"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                  title="Distinct topics with committed offsets"
                />
                <SortableHead
                  label="Consumer lag"
                  sortKey="lag"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                  title="Sum of end offset minus committed offset over every committed partition"
                />
                <SortableHead
                  label="Coordinator"
                  sortKey="coordinator"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                  title="Broker id of the group coordinator"
                />
                <SortableHead label="State" sortKey="state" sort={sort} onSort={onSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              <SpacerRow height={paddingTop} columns={COLUMNS} />
              {items.map((item) => {
                const group = visible[item.index];
                return (
                  <GroupRow
                    key={group.groupId}
                    group={group}
                    rowIndex={item.index + 2}
                    measured={lookup(group.groupId)}
                    onOpenGroup={onOpenGroup}
                  />
                );
              })}
              <SpacerRow height={paddingBottom} columns={COLUMNS} />
            </TableBody>
          </table>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const kind = groupStateKind(state);
  return (
    <span
      data-testid="kafka-group-state"
      data-state={kind}
      title={kind === "rebalancing" ? "Rebalancing" : undefined}
      className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide", STATE_BADGE[kind])}
    >
      {stateLabel(state)}
    </span>
  );
}

/** One row, memoized: a settled lag batch re-renders only the rows it measured. */
const GroupRow = memo(function GroupRow({
  group,
  rowIndex,
  measured,
  onOpenGroup,
}: {
  group: KafkaConsumerGroupSummary;
  rowIndex: number;
  measured: GroupMeasure | undefined;
  onOpenGroup: (groupId: string) => void;
}) {
  return (
    <TableRow data-testid="kafka-group-row" aria-rowindex={rowIndex} style={{ height: VIRTUAL_ROW_HEIGHT }}>
      <TableCell>
        <button
          type="button"
          onClick={() => onOpenGroup(group.groupId)}
          className="font-medium text-fg hover:text-brand text-left"
        >
          {group.groupId}
        </button>
      </TableCell>
      <TableCell className="text-right font-mono">{group.members}</TableCell>
      <TableCell className="text-right font-mono">
        <MeasuredValue
          measured={measured && { value: measured.topics, error: measured.topics === null ? measured.error : null }}
        />
      </TableCell>
      <TableCell className="text-right font-mono">
        <MeasuredValue measured={measured && { value: measured.totalLag, error: measured.error }} />
      </TableCell>
      <TableCell className="text-right font-mono">{group.coordinator ?? "—"}</TableCell>
      <TableCell>
        <StateBadge state={group.state} />
      </TableCell>
    </TableRow>
  );
});

/** Nulls last in either direction, then name. */
function compareNullable(left: number | null, right: number | null, sign: number): number {
  if (left === null || right === null) return (left === null ? 1 : 0) - (right === null ? 1 : 0);
  return sign * (left - right);
}

/**
 * Name order breaks every tie. Unknown numbers (unmeasured lag or topics, no
 * coordinator) sort last in either direction: an unknown is not a zero.
 */
function sortGroups(
  groups: readonly KafkaConsumerGroupSummary[],
  sort: SortState<GroupSortKey>,
  measuredOf: ((groupId: string) => GroupMeasure | undefined) | null,
): KafkaConsumerGroupSummary[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byName = (a: KafkaConsumerGroupSummary, b: KafkaConsumerGroupSummary) => a.groupId.localeCompare(b.groupId);
  const rank = (a: KafkaConsumerGroupSummary, b: KafkaConsumerGroupSummary): number => {
    switch (sort.key) {
      case "name":
        return 0;
      case "members":
        return sign * (a.members - b.members);
      case "coordinator":
        return compareNullable(a.coordinator, b.coordinator, sign);
      case "state":
        return sign * stateLabel(a.state).localeCompare(stateLabel(b.state));
      case "topics":
        return compareNullable(measuredOf?.(a.groupId)?.topics ?? null, measuredOf?.(b.groupId)?.topics ?? null, sign);
      case "lag":
        return compareNullable(
          measuredOf?.(a.groupId)?.totalLag ?? null,
          measuredOf?.(b.groupId)?.totalLag ?? null,
          sign,
        );
    }
  };
  return [...groups].sort((a, b) => rank(a, b) || (sort.key === "name" ? sign : 1) * byName(a, b));
}
