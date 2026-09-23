"use client";

import { useCallback, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaTopicListing } from "@/lib/resources/operations";
import { errorText, parseKeyValueLines, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, fieldClass, Loading, Notice, textareaClass } from "./parts";

/**
 * The topic list: name filter, an internal-topic toggle (the `__*` set is a
 * filter here, not hidden), and the create form. Counts are approximate —
 * the header says so rather than letting a compacted topic's sum pass as a
 * row count.
 */
export function KafkaTopicsPanel({
  connection,
  onOpenTopic,
}: {
  connection: ResourceConnection;
  onOpenTopic: (topic: string) => void;
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

  const needle = filter.trim().toLowerCase();
  const visible = (listing?.topics ?? []).filter(
    (topic) => (showInternal || !topic.internal) && topic.name.toLowerCase().includes(needle),
  );

  return (
    <div data-testid="kafka-topics" className="space-y-3">
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
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => void load()}>
            <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreating((open) => !open)}>
            <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Create topic
          </Button>
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
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Topic</TableHead>
              <TableHead className="text-right">Partitions</TableHead>
              <TableHead className="text-right">Replication</TableHead>
              <TableHead className="text-right">Under-replicated</TableHead>
              <TableHead className="text-right" title="Sum of high minus low watermarks — approximate">
                Messages (approx.)
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((topic) => (
              <TableRow key={topic.name} data-testid="kafka-topic-row">
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
                <TableCell
                  className={`text-right font-mono ${topic.underReplicatedPartitions > 0 ? "text-warning" : ""}`}
                >
                  {topic.underReplicatedPartitions}
                </TableCell>
                <TableCell className="text-right font-mono">{topic.messageCount ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {listing?.countsTruncated && (
        <p className="text-xs text-fg-subtle">Message counts are measured for the first 200 topics only.</p>
      )}
    </div>
  );
}
