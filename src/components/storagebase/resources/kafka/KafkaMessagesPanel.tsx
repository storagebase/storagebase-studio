"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaMessagesPage } from "@/storagebase/resources/operations";
import { errorText, formatPayload, formatTimestamp, postKafka } from "./kafka-api";
import { fieldClass } from "./parts";

type SeekMode = "earliest" | "latest" | "offset" | "timestamp";

/** A bounded message read from a seek position. The values are shown, never audited by the client. */
export function KafkaMessagesPanel({ connection, topic }: { connection: ResourceConnection; topic: string }) {
  const [mode, setMode] = useState<SeekMode>("earliest");
  const [argument, setArgument] = useState("");
  const [limit, setLimit] = useState("50");
  const [page, setPage] = useState<KafkaMessagesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const seek =
      mode === "offset"
        ? { mode, offset: argument.trim() }
        : mode === "timestamp"
          ? { mode, timestamp: Number(argument) }
          : { mode };
    setBusy(true);
    setError(null);
    try {
      const answer = await postKafka<KafkaMessagesPage>(connection, "messages", {
        topic,
        seek,
        limit: Number(limit),
      });
      setPage(answer);
    } catch (readError) {
      setError(errorText(readError));
    } finally {
      setBusy(false);
    }
  }, [connection, topic, mode, argument, limit]);

  return (
    <div data-testid="kafka-messages" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-fg-muted" htmlFor="kafka-seek-mode">
          From
        </label>
        <select
          id="kafka-seek-mode"
          aria-label="Seek mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as SeekMode)}
          className={fieldClass}
        >
          <option value="earliest">earliest</option>
          <option value="latest">latest</option>
          <option value="offset">offset</option>
          <option value="timestamp">timestamp</option>
        </select>
        {(mode === "offset" || mode === "timestamp") && (
          <Input
            aria-label="Seek argument"
            value={argument}
            onChange={(event) => setArgument(event.target.value)}
            className={`${fieldClass} w-40`}
          />
        )}
        <Input
          aria-label="Limit"
          type="number"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          className={`${fieldClass} w-20`}
        />
        <Button size="sm" className="text-xs" disabled={busy} onClick={() => void load()}>
          Read messages
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {page !== null && (
        <div data-testid="kafka-message-list" className="space-y-2">
          {page.messages.map((message) => (
            <div
              key={`${message.partition}-${message.offset}`}
              data-testid="kafka-message"
              className="rounded border border-hairline p-2 text-xs"
            >
              <div className="flex gap-3 text-fg-muted">
                <span>partition {message.partition}</span>
                <span>offset {message.offset}</span>
                <span>{formatTimestamp(message.timestamp)}</span>
              </div>
              <pre className="whitespace-pre-wrap font-mono mt-1">{formatPayload(message.value)}</pre>
            </div>
          ))}
          {page.messages.length === 0 && <p className="text-xs text-fg-muted">No messages in this window.</p>}
          {page.truncated && <p className="text-xs text-fg-subtle">Truncated — more messages exist.</p>}
        </div>
      )}
    </div>
  );
}
