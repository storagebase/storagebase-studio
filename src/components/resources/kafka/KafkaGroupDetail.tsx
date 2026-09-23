"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaConsumerGroupDetail } from "@/lib/resources/operations";
import { errorText, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ConfirmByName, ErrorLine, fieldClass, Loading, Notice, selectClass } from "./parts";

type ResetMode = "earliest" | "latest" | "timestamp" | "offset";

/**
 * One consumer group: members with their assignments, per-partition
 * committed / end offset / lag, and the two group writes. Both writes are
 * offered only while the group is Empty — Kafka refuses them otherwise and
 * the provider enforces the same rule — so the reason is shown up front
 * instead of as an error after the click.
 */
export function KafkaGroupDetail({
  connection,
  groupId,
  onBack,
  onDeleted,
}: {
  connection: ResourceConnection;
  groupId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const read = useCallback(
    () => postKafka<KafkaConsumerGroupDetail>(connection, "group", { groupId }),
    [connection, groupId],
  );
  const { data: detail, error: readError, reload: load } = useKafkaRead(read);
  const [writeError, setError] = useState<string | null>(null);
  const error = writeError ?? readError;
  const [notice, setNotice] = useState<string | null>(null);
  // Null until typed: the first topic the group has offsets on is the default.
  const [typedTopic, setResetTopic] = useState<string | null>(null);
  const resetTopic = typedTopic ?? detail?.offsets[0]?.topic ?? "";
  const [resetMode, setResetMode] = useState<ResetMode>("earliest");
  const [resetOffset, setResetOffset] = useState("0");
  const [resetTime, setResetTime] = useState("");

  const blocked =
    detail !== null && detail.state !== "Empty"
      ? `The group is ${detail.state} with ${detail.members.length} active member(s). Stop its consumers first: Kafka only allows this on an Empty group.`
      : null;

  const reset = async () => {
    let target: Record<string, unknown> = { mode: resetMode };
    if (resetMode === "offset") target = { mode: resetMode, offset: resetOffset.trim() };
    if (resetMode === "timestamp") {
      const millis = new Date(resetTime).getTime();
      if (Number.isNaN(millis)) {
        setError("Pick a date and time to reset to.");
        return;
      }
      target = { mode: resetMode, timestamp: millis };
    }
    setError(null);
    setNotice(null);
    try {
      await postKafka(connection, "group/reset-offsets", { groupId, topic: resetTopic.trim(), reset: target });
      setNotice(`Offsets of ${groupId} on ${resetTopic.trim()} reset.`);
      await load();
    } catch (resetError) {
      setError(errorText(resetError));
    }
  };

  const deleteGroup = async () => {
    setError(null);
    try {
      await postKafka(connection, "group/delete", { groupId });
      onDeleted();
    } catch (deleteError) {
      setError(errorText(deleteError));
    }
  };

  const topics = [...new Set(detail?.offsets.map((row) => row.topic) ?? [])];

  return (
    <div data-testid="kafka-group-detail" className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-xs" onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Consumer groups
        </Button>
        <h2 className="text-sm font-medium text-fg truncate">{groupId}</h2>
        {detail && <span className="text-xs text-fg-subtle">{detail.state}</span>}
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => void load()}>
          <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      <ErrorLine error={error} />
      <Notice notice={notice} />

      {detail === null ? (
        error === null && <Loading label="Reading the group…" />
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-fg-muted">Members ({detail.members.length})</h3>
            {detail.members.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active members.</p>
            ) : (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Client id</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Assigned partitions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.members.map((member) => (
                    <TableRow key={member.memberId} data-testid="kafka-member-row">
                      <TableCell className="font-mono" title={member.memberId}>
                        {member.clientId}
                      </TableCell>
                      <TableCell className="font-mono">{member.clientHost}</TableCell>
                      <TableCell className="font-mono">
                        {member.assignments
                          .map((entry) => `${entry.topic} [${entry.partitions.join(", ")}]`)
                          .join("; ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-fg-muted">Offsets</h3>
            {detail.offsets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No committed offsets.</p>
            ) : (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Topic</TableHead>
                    <TableHead>Partition</TableHead>
                    <TableHead className="text-right">Committed</TableHead>
                    <TableHead className="text-right">End offset</TableHead>
                    <TableHead className="text-right">Lag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.offsets.map((row) => (
                    <TableRow key={`${row.topic}/${row.partition}`} data-testid="kafka-offset-row">
                      <TableCell className="font-mono">{row.topic}</TableCell>
                      <TableCell className="font-mono">{row.partition}</TableCell>
                      <TableCell className="text-right font-mono">{row.committedOffset ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono">{row.endOffset}</TableCell>
                      <TableCell className="text-right font-mono">{row.lag ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section
            data-testid="kafka-reset-offsets"
            className="rounded-md border border-hairline bg-panel p-3 space-y-2"
          >
            <h3 className="text-xs font-medium text-fg">Reset offsets</h3>
            {blocked && <p className="text-xs text-warning leading-relaxed">{blocked}</p>}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="kafka-reset-topic" className="text-xs text-fg-muted">
                  Topic
                </Label>
                <Input
                  id="kafka-reset-topic"
                  list="kafka-reset-topics"
                  value={resetTopic}
                  onChange={(e) => setResetTopic(e.target.value)}
                  className={`${fieldClass} w-56`}
                />
                <datalist id="kafka-reset-topics">
                  {topics.map((topic) => (
                    <option key={topic} value={topic}>
                      {topic}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label htmlFor="kafka-reset-mode" className="text-xs text-fg-muted">
                  To
                </Label>
                <select
                  id="kafka-reset-mode"
                  value={resetMode}
                  onChange={(e) => setResetMode(e.target.value as ResetMode)}
                  className={selectClass}
                >
                  <option value="earliest">Earliest</option>
                  <option value="latest">Latest</option>
                  <option value="timestamp">Timestamp</option>
                  <option value="offset">Specific offset</option>
                </select>
              </div>
              {resetMode === "offset" && (
                <Input
                  aria-label="Reset offset"
                  value={resetOffset}
                  onChange={(e) => setResetOffset(e.target.value)}
                  className={`${fieldClass} w-28`}
                />
              )}
              {resetMode === "timestamp" && (
                <Input
                  aria-label="Reset timestamp"
                  type="datetime-local"
                  value={resetTime}
                  onChange={(e) => setResetTime(e.target.value)}
                  className={`${fieldClass} w-52`}
                />
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={blocked !== null || resetTopic.trim() === ""}
                onClick={() => void reset()}
              >
                Reset offsets
              </Button>
            </div>
          </section>

          <ConfirmByName
            name={groupId}
            action="Delete group"
            consequence="Deleting a group removes its committed offsets; its consumers restart from their reset policy."
            disabledReason={blocked}
            onConfirm={deleteGroup}
          />
        </>
      )}
    </div>
  );
}
