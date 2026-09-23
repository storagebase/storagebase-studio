"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Play, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaMessagesPage, KafkaProduceResult, KafkaRecord } from "@/lib/resources/operations";
import { errorText, formatPayload, formatTimestamp, parseKeyValueLines, postKafka } from "./kafka-api";
import { ErrorLine, fieldClass, Loading, Notice, selectClass, textareaClass } from "./parts";

/**
 * Browse and produce. A read is one bounded request — seek mode, partition
 * and page size in, a snapshot page out (the provider never waits for new
 * arrivals) — so "Read" is explicit rather than a live tail. The text filter
 * runs over the page already fetched: it narrows what is shown, never what
 * is read, and says so.
 */

type SeekMode = "earliest" | "latest" | "offset" | "timestamp";

const PREVIEW_CHARS = 120;

function preview(text: string | null): string {
  if (text === null) return "";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function matches(record: KafkaRecord, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [record.key ?? "", record.value ?? "", ...Object.entries(record.headers).flat()];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

export function KafkaMessagesPanel({
  connection,
  topic,
  partitions,
}: {
  connection: ResourceConnection;
  topic: string;
  partitions: readonly number[];
}) {
  const [partition, setPartition] = useState("all");
  const [mode, setMode] = useState<SeekMode>("latest");
  const [offset, setOffset] = useState("0");
  const [timestamp, setTimestamp] = useState("");
  const [limit, setLimit] = useState("50");
  const [page, setPage] = useState<KafkaMessagesPage | null>(null);
  // True from mount: the first read starts in the mount effect.
  const [reading, setReading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [producing, setProducing] = useState(false);
  const [produceKey, setProduceKey] = useState("");
  const [produceValue, setProduceValue] = useState("");
  const [produceHeaders, setProduceHeaders] = useState("");
  const [producePartition, setProducePartition] = useState("any");

  // The request alone, no state: shared by the mount read and the button.
  const fetchPage = useCallback(
    (seek: Record<string, unknown>) =>
      postKafka<KafkaMessagesPage>(connection, "messages", {
        topic,
        seek,
        limit: Number(limit),
        ...(partition === "all" ? {} : { partition: Number(partition) }),
      }),
    [connection, topic, limit, partition],
  );

  const settle = useCallback((next: KafkaMessagesPage | null, readError: unknown) => {
    if (next !== null) {
      setPage(next);
      setExpanded(null);
    }
    setError(readError === null ? null : errorText(readError));
    setReading(false);
  }, []);

  const read = (seek: Record<string, unknown>) => {
    setError(null);
    setReading(true);
    fetchPage(seek).then(
      (next) => settle(next, null),
      (readError: unknown) => settle(null, readError),
    );
  };

  // The first read, once per topic: newest messages. State is written only
  // after it settles; the seek controls drive every later read explicitly.
  useEffect(() => {
    let cancelled = false;
    fetchPage({ mode: "latest" }).then(
      (next) => {
        if (!cancelled) settle(next, null);
      },
      (readError: unknown) => {
        if (!cancelled) settle(null, readError);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, topic]);

  const currentSeek = (): Record<string, unknown> | string => {
    if (mode === "offset") return { mode, offset: offset.trim() };
    if (mode === "timestamp") {
      const millis = new Date(timestamp).getTime();
      return Number.isNaN(millis) ? "Pick a date and time to seek to." : { mode, timestamp: millis };
    }
    return { mode };
  };

  const produce = async () => {
    const headers = parseKeyValueLines(produceHeaders);
    if (typeof headers === "string") {
      setError(`Headers: ${headers}`);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const result = await postKafka<KafkaProduceResult>(connection, "produce", {
        topic,
        value: produceValue,
        ...(produceKey === "" ? {} : { key: produceKey }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(producePartition === "any" ? {} : { partition: Number(producePartition) }),
      });
      setNotice(`Produced to partition ${result.partition} at offset ${result.offset}.`);
      setProduceValue("");
    } catch (produceError) {
      setError(errorText(produceError));
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = (page?.messages ?? []).filter((record) => matches(record, needle));

  return (
    <div data-testid="kafka-messages" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="kafka-read-partition" className="text-xs text-fg-muted">
            Partition
          </Label>
          <select
            id="kafka-read-partition"
            value={partition}
            onChange={(e) => setPartition(e.target.value)}
            className={selectClass}
          >
            <option value="all">All partitions</option>
            {partitions.map((entry) => (
              <option key={entry} value={String(entry)}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="kafka-read-seek" className="text-xs text-fg-muted">
            Seek
          </Label>
          <select
            id="kafka-read-seek"
            value={mode}
            onChange={(e) => setMode(e.target.value as SeekMode)}
            className={selectClass}
          >
            <option value="latest">Newest (tail)</option>
            <option value="earliest">Oldest</option>
            <option value="offset">From offset</option>
            <option value="timestamp">From timestamp</option>
          </select>
        </div>
        {mode === "offset" && (
          <div className="space-y-1">
            <Label htmlFor="kafka-read-offset" className="text-xs text-fg-muted">
              Offset
            </Label>
            <Input
              id="kafka-read-offset"
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
              className={`${fieldClass} w-28`}
            />
          </div>
        )}
        {mode === "timestamp" && (
          <div className="space-y-1">
            <Label htmlFor="kafka-read-timestamp" className="text-xs text-fg-muted">
              From
            </Label>
            <Input
              id="kafka-read-timestamp"
              type="datetime-local"
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              className={`${fieldClass} w-52`}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="kafka-read-limit" className="text-xs text-fg-muted">
            Messages
          </Label>
          <Input
            id="kafka-read-limit"
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className={`${fieldClass} w-20`}
          />
        </div>
        <Button
          size="sm"
          className="text-xs"
          disabled={reading}
          onClick={() => {
            const seek = currentSeek();
            if (typeof seek === "string") {
              setError(seek);
              return;
            }
            read(seek);
          }}
        >
          <Play strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Read
        </Button>
        <Button variant="outline" size="sm" className="text-xs" onClick={() => setProducing((open) => !open)}>
          <Send strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Produce
        </Button>
      </div>

      {producing && (
        <div data-testid="kafka-produce" className="rounded-md border border-hairline bg-panel p-3 space-y-2 max-w-2xl">
          <div className="flex gap-2">
            <Input
              aria-label="Message key"
              placeholder="Key (optional)"
              value={produceKey}
              onChange={(e) => setProduceKey(e.target.value)}
              className={fieldClass}
            />
            <select
              aria-label="Target partition"
              value={producePartition}
              onChange={(e) => setProducePartition(e.target.value)}
              className={selectClass}
            >
              <option value="any">Partitioner decides</option>
              {partitions.map((entry) => (
                <option key={entry} value={String(entry)}>
                  Partition {entry}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label="Message value"
            rows={4}
            placeholder="Value"
            value={produceValue}
            onChange={(e) => setProduceValue(e.target.value)}
            className={textareaClass}
          />
          <textarea
            aria-label="Message headers"
            rows={2}
            placeholder="Headers: name=value per line (optional)"
            value={produceHeaders}
            onChange={(e) => setProduceHeaders(e.target.value)}
            className={textareaClass}
          />
          <Button size="sm" className="text-xs" onClick={() => void produce()}>
            Send
          </Button>
        </div>
      )}

      <ErrorLine error={error} />
      <Notice notice={notice} />

      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter messages"
          placeholder="Filter this page (key, value, headers)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`${fieldClass} w-72`}
        />
        {page !== null && (
          <span className="text-xs text-fg-subtle">
            {visible.length} of {page.messages.length} shown
            {page.truncated ? " · more messages exist in this range" : ""}
          </span>
        )}
      </div>

      {page === null ? (
        reading && <Loading label="Reading messages…" />
      ) : page.messages.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No messages in this range.</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Partition</TableHead>
              <TableHead>Offset</TableHead>
              <TableHead>Timestamp</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((record) => {
              const id = `${record.partition}/${record.offset}`;
              return (
                <React.Fragment key={id}>
                  <TableRow
                    data-testid="kafka-message-row"
                    className="cursor-pointer"
                    aria-expanded={expanded === id}
                    onClick={() => setExpanded(expanded === id ? null : id)}
                  >
                    <TableCell className="font-mono">{record.partition}</TableCell>
                    <TableCell className="font-mono">{record.offset}</TableCell>
                    <TableCell className="font-mono whitespace-nowrap">{formatTimestamp(record.timestamp)}</TableCell>
                    <TableCell className="font-mono max-w-40 truncate">{record.key ?? "—"}</TableCell>
                    <TableCell className="font-mono max-w-md truncate">{preview(record.value)}</TableCell>
                  </TableRow>
                  {expanded === id && (
                    <TableRow data-testid="kafka-message-detail">
                      <TableCell colSpan={5} className="bg-sunken space-y-2">
                        <div className="text-fg-subtle">
                          {record.valueBytes} bytes · key {record.keyEncoding} · value {record.valueEncoding}
                          {record.valueTruncated ? " · value cut at 64 KiB" : ""}
                        </div>
                        {record.key !== null && (
                          <pre className="font-mono whitespace-pre-wrap break-all text-fg-secondary">
                            {formatPayload(record.key)}
                          </pre>
                        )}
                        <pre className="font-mono whitespace-pre-wrap break-all text-fg">
                          {record.valueEncoding === "utf8" ? formatPayload(record.value) : record.value}
                        </pre>
                        {Object.keys(record.headers).length > 0 && (
                          <ul className="font-mono text-fg-secondary">
                            {Object.entries(record.headers).map(([name, value]) => (
                              <li key={name}>
                                {name}: {value}
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
