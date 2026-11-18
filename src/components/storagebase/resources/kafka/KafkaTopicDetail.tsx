"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaTopicDetail as TopicDetail } from "@/storagebase/resources/operations";
import { errorText, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ConfirmByName, ErrorLine, fieldClass, Loading, Notice, SectionTabs, textareaClass } from "./parts";
import { KafkaMessagesPanel } from "./KafkaMessagesPanel";

type Tab = "overview" | "messages" | "config";
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "messages", label: "Messages" },
  { id: "config", label: "Config" },
] as const;

/** One topic: partitions, config, a bounded message read, and the write controls. */
export function KafkaTopicDetail({
  connection,
  topic,
  readOnly = false,
  onBack,
}: {
  connection: ResourceConnection;
  topic: string;
  readOnly?: boolean;
  onBack: () => void;
}) {
  const read = useCallback(() => postKafka<TopicDetail>(connection, "topic", { topic }), [connection, topic]);
  const { data, error: readError, reload } = useKafkaRead(read);
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [partitions, setPartitions] = useState("2");
  const [configText, setConfigText] = useState("");
  const [busy, setBusy] = useState(false);

  const write = async (route: string, payload: Record<string, unknown>, message: string) => {
    setWriteError(null);
    setNotice(null);
    setBusy(true);
    try {
      await postKafka(connection, route, { topic, ...payload });
      setNotice(message);
      await reload();
    } catch (error) {
      setWriteError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const alter = () => {
    const changes: Record<string, string | null> = {};
    for (const line of configText.split("\n")) {
      const index = line.indexOf("=");
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      changes[key] = value === "" ? null : value;
    }
    return void write("topic/config", { changes }, "Config updated.");
  };

  return (
    <div data-testid="kafka-topic-detail" className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="text-xs" onClick={onBack}>
          ← Topics
        </Button>
        <h2 className="text-sm font-medium">{topic}</h2>
        {!readOnly && (
          <div className="ml-auto flex items-center gap-2">
            <Input
              aria-label="New partition count"
              type="number"
              value={partitions}
              onChange={(event) => setPartitions(event.target.value)}
              className={`${fieldClass} w-24`}
            />
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => void write("topic/partitions", { count: Number(partitions) }, "Partitions added.")}
            >
              Add partitions
            </Button>
            <ConfirmByName
              name={topic}
              action="Delete topic"
              consequence="Deleting a topic removes every message it holds and cannot be undone."
              onConfirm={async () => {
                await write("topic/delete", { confirm: topic }, "Topic deleted.");
              }}
            />
          </div>
        )}
      </div>
      <SectionTabs label="Topic sections" tabs={TABS} active={tab} onChange={setTab} />
      <ErrorLine error={writeError ?? readError} />
      <Notice notice={notice} />
      {tab === "overview" &&
        (data === null ? (
          readError === null && <Loading label="Describing topic…" />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Partition</th>
                <th className="text-left">Leader</th>
                <th className="text-right">Earliest</th>
                <th className="text-right">Latest</th>
              </tr>
            </thead>
            <tbody>
              {data.partitions.map((part) => (
                <tr key={part.partition} data-testid="kafka-partition-row">
                  <td>{part.partition}</td>
                  <td>{part.leader}</td>
                  <td className="text-right font-mono">{part.earliestOffset ?? "-"}</td>
                  <td className="text-right font-mono">{part.latestOffset ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === "messages" && <KafkaMessagesPanel connection={connection} topic={topic} />}
      {tab === "config" &&
        (data === null ? (
          <Loading label="Describing topic…" />
        ) : (
          <div className="space-y-2">
            <table className="w-full text-xs">
              <tbody>
                {data.configs.map((entry) => (
                  <tr key={entry.name} data-testid="kafka-config-row">
                    <td className="font-mono">{entry.name}</td>
                    <td className="font-mono">{entry.value ?? (entry.isSensitive ? "(sensitive)" : "-")}</td>
                    <td>{entry.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!readOnly && (
              <div className="space-y-2 max-w-lg">
                <textarea
                  aria-label="Config changes"
                  value={configText}
                  onChange={(event) => setConfigText(event.target.value)}
                  placeholder="retention.ms=60000"
                  className={textareaClass}
                />
                <Button size="sm" className="text-xs" disabled={busy} onClick={alter}>
                  Apply config
                </Button>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
