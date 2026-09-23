"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaTopicDetail as TopicDetail } from "@/lib/resources/operations";
import { errorText, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ConfirmByName, ErrorLine, fieldClass, Loading, Notice, SectionTabs } from "./parts";
import { KafkaMessagesPanel } from "./KafkaMessagesPanel";
import { KafkaTopicConfigPanel } from "./KafkaTopicConfigPanel";

type TopicTab = "messages" | "partitions" | "configuration";

const TOPIC_TABS = [
  { id: "messages", label: "Messages" },
  { id: "partitions", label: "Partitions" },
  { id: "configuration", label: "Configuration" },
] as const;

/**
 * One topic: messages, partitions (leader / replicas / ISR / offsets) and
 * configuration, with the topic-level writes — add partitions and the typed
 * delete. The detail is read once and re-read after a write lands.
 */
export function KafkaTopicDetail({
  connection,
  topic,
  onBack,
  onDeleted,
}: {
  connection: ResourceConnection;
  topic: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<TopicTab>("messages");
  const read = useCallback(() => postKafka<TopicDetail>(connection, "topic", { topic }), [connection, topic]);
  const { data: detail, error: readError, reload: load } = useKafkaRead(read);
  const [writeError, setError] = useState<string | null>(null);
  const error = writeError ?? readError;
  const [notice, setNotice] = useState<string | null>(null);
  // Empty means "one more than the topic has now", derived from the latest read.
  const [partitionInput, setPartitionCount] = useState("");
  const partitionCount = partitionInput || String((detail?.partitions.length ?? 0) + 1);

  const addPartitions = async () => {
    setError(null);
    setNotice(null);
    try {
      await postKafka(connection, "topic/partitions", { topic, count: Number(partitionCount) });
      setNotice(`Topic now has ${partitionCount} partitions.`);
      setPartitionCount("");
      await load();
    } catch (writeError) {
      setError(errorText(writeError));
    }
  };

  const deleteTopic = async () => {
    setError(null);
    try {
      await postKafka(connection, "topic/delete", { topic, confirm: topic });
      onDeleted();
    } catch (deleteError) {
      setError(errorText(deleteError));
    }
  };

  return (
    <div data-testid="kafka-topic-detail" className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-xs" onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Topics
        </Button>
        <h2 className="text-sm font-medium text-fg truncate">{topic}</h2>
        {detail?.internal && <span className="text-xs text-fg-subtle">internal</span>}
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => void load()}>
          <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      <SectionTabs label="Topic sections" tabs={TOPIC_TABS} active={tab} onChange={setTab} />
      <ErrorLine error={error} />
      <Notice notice={notice} />

      {detail === null ? (
        error === null && <Loading label="Reading the topic…" />
      ) : tab === "messages" ? (
        <KafkaMessagesPanel
          connection={connection}
          topic={topic}
          partitions={detail.partitions.map((partition) => partition.partition)}
        />
      ) : tab === "partitions" ? (
        <div className="space-y-4">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Partition</TableHead>
                <TableHead>Leader</TableHead>
                <TableHead>Replicas</TableHead>
                <TableHead>In-sync replicas</TableHead>
                <TableHead className="text-right">Earliest offset</TableHead>
                <TableHead className="text-right">Latest offset</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.partitions.map((partition) => (
                <TableRow key={partition.partition} data-testid="kafka-partition-row">
                  <TableCell className="font-mono">{partition.partition}</TableCell>
                  <TableCell className="font-mono">{partition.leader}</TableCell>
                  <TableCell className="font-mono">{partition.replicas.join(", ")}</TableCell>
                  <TableCell
                    className={`font-mono ${partition.isr.length < partition.replicas.length ? "text-warning" : ""}`}
                  >
                    {partition.isr.join(", ")}
                  </TableCell>
                  <TableCell className="text-right font-mono">{partition.earliestOffset}</TableCell>
                  <TableCell className="text-right font-mono">{partition.latestOffset}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="kafka-partition-count" className="text-xs text-fg-muted block">
                New partition total
              </label>
              <Input
                id="kafka-partition-count"
                type="number"
                min={detail.partitions.length + 1}
                value={partitionCount}
                onChange={(e) => setPartitionCount(e.target.value)}
                className={`${fieldClass} w-28`}
              />
            </div>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => void addPartitions()}>
              Add partitions
            </Button>
            <p className="text-xs text-fg-subtle basis-full">
              Partitions can only be added. Keyed records may map to a different partition afterwards.
            </p>
          </div>
          <ConfirmByName
            name={topic}
            action="Delete topic"
            consequence="Deleting a topic removes every message and every consumer offset on it."
            onConfirm={deleteTopic}
          />
        </div>
      ) : (
        <KafkaTopicConfigPanel connection={connection} topic={topic} configs={detail.configs} onChanged={load} />
      )}
    </div>
  );
}
