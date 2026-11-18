"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaTopicListing, KafkaTopicCount } from "@/storagebase/resources/operations";
import { errorText, parseKeyValueLines, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, fieldClass, Loading, Notice } from "./parts";

/** Metadata-only topic list with a name filter and the create form. */
export function KafkaTopicsPanel({
  connection,
  onOpenTopic,
  readOnly = false,
}: {
  connection: ResourceConnection;
  onOpenTopic: (topic: string) => void;
  readOnly?: boolean;
}) {
  const read = useCallback(() => postKafka<KafkaTopicListing>(connection, "topics"), [connection]);
  const { data, error: readError, reload } = useKafkaRead(read);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState("1");
  const [replication, setReplication] = useState("1");
  const [configText, setConfigText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<string, KafkaTopicCount>>({});

  const visible = useMemo(
    () => (data?.topics ?? []).filter((topic) => topic.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [data, filter],
  );

  const loadCounts = useCallback(async () => {
    const names = visible.slice(0, 25).map((topic) => topic.name);
    if (names.length === 0) return;
    const answer = await postKafka<{ counts: Record<string, KafkaTopicCount> }>(connection, "topics/counts", {
      topics: names,
    });
    setCounts(answer.counts);
  }, [connection, visible]);
  const refresh = useCallback(async () => {
    await loadCounts().catch(() => undefined);
    await reload();
  }, [loadCounts, reload]);

  const create = async () => {
    const configs = parseKeyValueLines(configText);
    if (typeof configs === "string") {
      setWriteError(`Configs: ${configs}`);
    } else {
      setWriteError(null);
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
        await reload();
      } catch (createError) {
        setWriteError(errorText(createError));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div data-testid="kafka-topics" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter topics"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={`${fieldClass} w-56`}
          placeholder="Filter topics"
        />
        <Button variant="ghost" size="sm" className="text-xs" onClick={() => void refresh()}>
          Refresh
        </Button>
        {!readOnly && (
          <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreating((open) => !open)}>
            <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
            Create topic
          </Button>
        )}
      </div>

      {creating && (
        <div
          data-testid="kafka-create-topic"
          className="rounded-md border border-hairline bg-panel p-3 space-y-2 max-w-lg"
        >
          <Input
            aria-label="Topic name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={fieldClass}
          />
          <div className="flex gap-2">
            <Input
              aria-label="Partitions"
              type="number"
              value={partitions}
              onChange={(event) => setPartitions(event.target.value)}
              className={fieldClass}
            />
            <Input
              aria-label="Replication factor"
              type="number"
              value={replication}
              onChange={(event) => setReplication(event.target.value)}
              className={fieldClass}
            />
          </div>
          <textarea
            aria-label="Topic configs"
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            placeholder="retention.ms=604800000"
            className="w-full rounded-md border border-hairline bg-panel p-2 text-xs"
          />
          <Button size="sm" className="text-xs" disabled={busy || name.trim() === ""} onClick={() => void create()}>
            Create
          </Button>
        </div>
      )}

      <ErrorLine error={writeError ?? readError} />
      <Notice notice={notice} />
      {data === null ? (
        readError === null && <Loading label="Listing topics…" />
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">No topics match.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">Topic</th>
              <th className="text-right">Partitions</th>
              <th className="text-right">Replication</th>
              <th className="text-right">Messages (approx.)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((topic) => (
              <tr key={topic.name} data-testid="kafka-topic-row">
                <td>
                  <button
                    type="button"
                    onClick={() => onOpenTopic(topic.name)}
                    className="font-medium text-fg hover:text-brand"
                  >
                    {topic.name}
                  </button>
                  {topic.internal && <span className="ml-2 text-fg-subtle">internal</span>}
                </td>
                <td className="text-right font-mono">{topic.partitions}</td>
                <td className="text-right font-mono">{topic.replicationFactor}</td>
                <td className="text-right font-mono">{counts[topic.name]?.messageCount ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
