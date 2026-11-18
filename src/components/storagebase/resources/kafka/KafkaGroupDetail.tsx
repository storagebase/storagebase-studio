"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaConsumerGroupDetail } from "@/storagebase/resources/operations";
import { errorText, postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ConfirmByName, ErrorLine, fieldClass, Loading, Notice } from "./parts";

type ResetMode = "earliest" | "latest" | "offset" | "timestamp";

/** One consumer group: members, offsets, and the two admin actions. */
export function KafkaGroupDetail({
  connection,
  groupId,
  readOnly = false,
  onBack,
}: {
  connection: ResourceConnection;
  groupId: string;
  readOnly?: boolean;
  onBack: () => void;
}) {
  const read = useCallback(
    () => postKafka<KafkaConsumerGroupDetail>(connection, "group", { groupId }),
    [connection, groupId],
  );
  const { data, error: readError, reload } = useKafkaRead(read);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ResetMode>("earliest");
  const [argument, setArgument] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const reset = async () => {
    const value =
      mode === "offset"
        ? { mode, offset: argument.trim() }
        : mode === "timestamp"
          ? { mode, timestamp: Number(argument) }
          : { mode };
    setWriteError(null);
    setNotice(null);
    try {
      await postKafka(connection, "group/reset-offsets", { groupId, topic: topic.trim(), reset: value });
      setNotice("Offsets reset.");
      await reload();
    } catch (error) {
      setWriteError(errorText(error));
    }
  };

  const remove = async () => {
    try {
      await postKafka(connection, "group/delete", { groupId });
      onBack();
    } catch (error) {
      setWriteError(errorText(error));
    }
  };

  return (
    <div data-testid="kafka-group-detail" className="space-y-3">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="text-xs" onClick={onBack}>
          ← Groups
        </Button>
        <h2 className="text-sm font-medium">{groupId}</h2>
        {!readOnly && (
          <div className="ml-auto">
            <ConfirmByName
              name={groupId}
              action="Delete group"
              consequence="Deleting a consumer group discards its committed offsets."
              onConfirm={remove}
            />
          </div>
        )}
      </div>
      <ErrorLine error={writeError ?? readError} />
      <Notice notice={notice} />
      {data === null ? (
        readError === null && <Loading label="Describing group…" />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            {data.state} · {data.protocolType}/{data.protocol} · {data.members.length} member(s)
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Topic</th>
                <th className="text-right">Partition</th>
                <th className="text-right">Committed</th>
                <th className="text-right">End</th>
                <th className="text-right">Lag</th>
              </tr>
            </thead>
            <tbody>
              {data.offsets.map((offset) => (
                <tr key={`${offset.topic}-${offset.partition}`} data-testid="kafka-group-offset-row">
                  <td>{offset.topic}</td>
                  <td className="text-right font-mono">{offset.partition}</td>
                  <td className="text-right font-mono">{offset.committedOffset ?? "-"}</td>
                  <td className="text-right font-mono">{offset.endOffset ?? "-"}</td>
                  <td className="text-right font-mono">{offset.lag ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-hairline p-3">
              <Input
                aria-label="Offset reset topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="Topic"
                className={`${fieldClass} w-48`}
              />
              <select
                aria-label="Reset mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as ResetMode)}
                className={fieldClass}
              >
                <option value="earliest">earliest</option>
                <option value="latest">latest</option>
                <option value="offset">offset</option>
                <option value="timestamp">timestamp</option>
              </select>
              {(mode === "offset" || mode === "timestamp") && (
                <Input
                  aria-label="Reset argument"
                  value={argument}
                  onChange={(event) => setArgument(event.target.value)}
                  className={`${fieldClass} w-40`}
                />
              )}
              <Button size="sm" className="text-xs" onClick={() => void reset()}>
                Reset offsets
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
