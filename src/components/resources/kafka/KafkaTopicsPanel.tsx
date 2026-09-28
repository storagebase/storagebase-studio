"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaTopicCount, KafkaTopicListing, KafkaTopicSummary } from "@/lib/resources/operations";
import { errorText, parseKeyValueLines, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { type Measured, useLazyMeasure } from "./use-lazy-measure";
import {
  MeasuredValue,
  nextSort,
  SortableHead,
  type SortState,
  SpacerRow,
  useVirtualRows,
  VIRTUAL_ROW_HEIGHT,
} from "./virtual-list";
import { ErrorLine, fieldClass, Loading, Notice, textareaClass } from "./parts";

type TopicSortKey = "name" | "partitions" | "messages";

const COLUMNS = 5;

const unmeasured = (error: string): Measured => ({ value: null, error });

/**
 * The topic list: name filter, an internal-topic toggle (the `__*` set is a
 * filter here, not hidden), and the create form. The listing is metadata
 * only; message counts are measured for the rows on screen (`topics/counts`,
 * batched, cached for the session) and are approximate — the header says so
 * rather than letting a compacted topic's sum pass as a row count. Rows are
 * windowed, so a cluster with thousands of topics renders a screenful.
 */
export function KafkaTopicsPanel({
  connection,
  onOpenTopic,
  readOnly = false,
}: {
  connection: ResourceConnection;
  onOpenTopic: (topic: string) => void;
  /** Withholds Create topic. */
  readOnly?: boolean;
}) {
  const read = useCallback(() => postKafka<KafkaTopicListing>(connection, "topics"), [connection]);
  const { data: listing, error: readError, reload: load } = useKafkaRead(read);
  const [writeError, setError] = useState<string | null>(null);
  const error = writeError ?? readError;
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showInternal, setShowInternal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState("1");
  const [replication, setReplication] = useState("1");
  const [configText, setConfigText] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const configs = parseKeyValueLines(configText);
    if (typeof configs === "string") {
      setError(`Configs: ${configs}`);
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await postKafka(connection, "topic/create", {
        topic: name.trim(),
        partitions: Number(partitions),
        replicationFactor: Number(replication),
        configs,
      });
      setNotice(`Created topic ${name.trim()}.`);
      setCreating(false);
      setName("");
      setConfigText("");
      await load();
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setBusy(false);
    }
  };

  const measure = useCallback(
    async (topics: string[]): Promise<Record<string, Measured>> => {
      const { counts } = await postKafka<{ counts: Record<string, KafkaTopicCount> }>(connection, "topics/counts", {
        topics,
      });
      return Object.fromEntries(
        Object.entries(counts).map(([name, count]) => [name, { value: count.messageCount, error: count.countError }]),
      );
    },
    [connection],
  );
  const { lookup, want, reset } = useLazyMeasure<Measured>(`${connection.id}:topic-counts`, measure, unmeasured);
  const refresh = useCallback(async () => {
    reset();
    await load();
  }, [reset, load]);

  const [sort, setSort] = useState<SortState<TopicSortKey>>({ key: "name", direction: "asc" });
  const onSort = useCallback((key: TopicSortKey) => setSort((current) => nextSort(current, key)), []);
  // Typing stays instant: the filter over hundreds of rows runs at the deferred value.
  const needle = useDeferredValue(filter).trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (listing?.topics ?? []).filter(
        (topic) => (showInternal || !topic.internal) && topic.name.toLowerCase().includes(needle),
      ),
    [listing, showInternal, needle],
  );
  // Only the count sort depends on the measurements, so only it re-sorts when a batch lands.
  const countLookup = sort.key === "messages" ? lookup : null;
  const visible = useMemo(() => sortTopics(filtered, sort, countLookup), [filtered, sort, countLookup]);
  const { scrollRef, items, paddingTop, paddingBottom } = useVirtualRows(visible.length);
  const onScreen = items.map((item) => visible[item.index]?.name).filter((name) => name !== undefined);
  const onScreenKey = onScreen.join("\n");
  useEffect(() => {
    if (onScreenKey !== "") want(onScreenKey.split("\n"));
  }, [onScreenKey, want]);
  const unreadable = onScreen.filter((name) => typeof lookup(name)?.error === "string").length;

  return (
    <div data-testid="kafka-topics" className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter topics"
          placeholder="Filter topics"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`${fieldClass} w-56`}
        />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
          Show internal topics
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => void refresh()}>
            <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
          {!readOnly && (
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreating((open) => !open)}>
              <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
              Create topic
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <div
          data-testid="kafka-create-topic"
          className="rounded-md border border-hairline bg-panel p-3 space-y-2 max-w-lg"
        >
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-3 space-y-1">
              <Label htmlFor="kafka-topic-name" className="text-xs text-fg-muted">
                Topic name
              </Label>
              <Input
                id="kafka-topic-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-topic-partitions" className="text-xs text-fg-muted">
                Partitions
              </Label>
              <Input
                id="kafka-topic-partitions"
                type="number"
                min={1}
                value={partitions}
                onChange={(e) => setPartitions(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kafka-topic-rf" className="text-xs text-fg-muted">
                Replication factor
              </Label>
              <Input
                id="kafka-topic-rf"
                type="number"
                min={1}
                value={replication}
                onChange={(e) => setReplication(e.target.value)}
                className={fieldClass}
              />
            </div>
          </div>
          <Label htmlFor="kafka-topic-configs" className="text-xs text-fg-muted">
            Configs (name=value per line, optional)
          </Label>
          <textarea
            id="kafka-topic-configs"
            rows={3}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            placeholder={"retention.ms=604800000\ncleanup.policy=compact"}
            className={textareaClass}
          />
          <Button size="sm" className="text-xs" disabled={busy || name.trim() === ""} onClick={() => void create()}>
            Create
          </Button>
        </div>
      )}

      <ErrorLine error={error} />
      <Notice notice={notice} />

      {listing === null ? (
        error === null && <Loading label="Listing topics…" />
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No topics match.</p>
      ) : (
        <div ref={scrollRef} data-testid="kafka-topics-scroll" className="flex-1 min-h-64 overflow-auto">
          <table className="w-full caption-bottom text-xs" aria-rowcount={visible.length + 1}>
            <TableHeader className="sticky top-0 z-10 bg-surface">
              <TableRow aria-rowindex={1}>
                <SortableHead label="Topic" sortKey="name" sort={sort} onSort={onSort} />
                <SortableHead label="Partitions" sortKey="partitions" sort={sort} onSort={onSort} align="right" />
                <TableHead className="text-right">Replication</TableHead>
                <TableHead className="text-right">Under-replicated</TableHead>
                <SortableHead
                  label="Messages (approx.)"
                  sortKey="messages"
                  sort={sort}
                  onSort={onSort}
                  align="right"
                  title="Sum of high minus low watermarks — approximate; measured for the rows on screen"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              <SpacerRow height={paddingTop} columns={COLUMNS} />
              {items.map((item) => {
                const topic = visible[item.index];
                return (
                  <TopicRow
                    key={topic.name}
                    topic={topic}
                    rowIndex={item.index + 2}
                    measured={lookup(topic.name)}
                    onOpenTopic={onOpenTopic}
                  />
                );
              })}
              <SpacerRow height={paddingBottom} columns={COLUMNS} />
            </TableBody>
          </table>
        </div>
      )}
      {unreadable > 0 && (
        <p className="text-xs text-fg-subtle">
          Message counts could not be read for {unreadable} topic(s) on screen; hover the dash for the reason.
        </p>
      )}
    </div>
  );
}

/**
 * One row, memoized: a settled count batch re-renders only the rows whose
 * measurement changed, never the whole window.
 */
const TopicRow = memo(function TopicRow({
  topic,
  rowIndex,
  measured,
  onOpenTopic,
}: {
  topic: KafkaTopicSummary;
  rowIndex: number;
  measured: Measured | undefined;
  onOpenTopic: (topic: string) => void;
}) {
  return (
    <TableRow data-testid="kafka-topic-row" aria-rowindex={rowIndex} style={{ height: VIRTUAL_ROW_HEIGHT }}>
      <TableCell>
        <button
          type="button"
          onClick={() => onOpenTopic(topic.name)}
          className="font-medium text-fg hover:text-brand text-left"
        >
          {topic.name}
        </button>
        {topic.internal && <span className="ml-2 text-fg-subtle">internal</span>}
      </TableCell>
      <TableCell className="text-right font-mono">{topic.partitions}</TableCell>
      <TableCell className="text-right font-mono">{topic.replicationFactor}</TableCell>
      <TableCell className={`text-right font-mono ${topic.underReplicatedPartitions > 0 ? "text-warning" : ""}`}>
        {topic.underReplicatedPartitions}
      </TableCell>
      <TableCell className="text-right font-mono">
        <MeasuredValue measured={measured} />
      </TableCell>
    </TableRow>
  );
});

/**
 * Name order breaks every tie. By count, unmeasured rows sort last in either
 * direction: an unknown is not a zero.
 */
function sortTopics(
  topics: readonly KafkaTopicSummary[],
  sort: SortState<TopicSortKey>,
  countOf: ((name: string) => Measured | undefined) | null,
): KafkaTopicSummary[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byName = (a: KafkaTopicSummary, b: KafkaTopicSummary) => a.name.localeCompare(b.name);
  return [...topics].sort((a, b) => {
    if (sort.key === "name") return sign * byName(a, b);
    if (sort.key === "partitions") return sign * (a.partitions - b.partitions) || byName(a, b);
    const left = countOf?.(a.name)?.value ?? null;
    const right = countOf?.(b.name)?.value ?? null;
    if (left === null || right === null) return (left === null ? 1 : 0) - (right === null ? 1 : 0) || byName(a, b);
    return sign * (left - right) || byName(a, b);
  });
}
