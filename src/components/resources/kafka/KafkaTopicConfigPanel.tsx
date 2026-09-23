"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaConfigEntry } from "@/lib/resources/operations";
import { errorText, postKafka } from "./kafka-api";
import { ErrorLine, fieldClass, Notice } from "./parts";

/**
 * A topic's configuration: every entry with its source, edit in place for
 * the writable ones, reset for topic-level overrides, and an "add override"
 * row for a config the table does not list yet. The provider merges each
 * change into the existing override set (kafkajs' AlterConfigs replaces it
 * wholesale), so editing one entry never resets another.
 */
export function KafkaTopicConfigPanel({
  connection,
  topic,
  configs,
  onChanged,
}: {
  connection: ResourceConnection;
  topic: string;
  configs: readonly KafkaConfigEntry[];
  onChanged: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = async (changes: Record<string, string | null>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await postKafka(connection, "topic/config", { topic, changes });
      setNotice(done);
      setEditing(null);
      await onChanged();
    } catch (applyError) {
      setError(errorText(applyError));
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = configs.filter(
    (entry) => (!overridesOnly || entry.source === "TOPIC_CONFIG") && entry.name.toLowerCase().includes(needle),
  );

  return (
    <div data-testid="kafka-topic-config" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter configs"
          placeholder="Filter configs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`${fieldClass} w-56`}
        />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={overridesOnly} onChange={(e) => setOverridesOnly(e.target.checked)} />
          Topic overrides only
        </label>
      </div>
      <ErrorLine error={error} />
      <Notice notice={notice} />
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Source</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry) => (
            <TableRow key={entry.name} data-testid="kafka-config-row">
              <TableCell className="font-mono">{entry.name}</TableCell>
              <TableCell className="font-mono break-all">
                {editing === entry.name ? (
                  <Input
                    aria-label={`Value for ${entry.name}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className={fieldClass}
                  />
                ) : entry.isSensitive ? (
                  <span className="text-fg-subtle">(sensitive)</span>
                ) : (
                  entry.value
                )}
              </TableCell>
              <TableCell className={entry.source === "TOPIC_CONFIG" ? "text-brand" : "text-fg-subtle"}>
                {entry.source}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {editing === entry.name ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => void apply({ [entry.name]: draft }, `Set ${entry.name}.`)}
                    >
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  !entry.readOnly &&
                  !entry.isSensitive && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        aria-label={`Edit ${entry.name}`}
                        onClick={() => {
                          setEditing(entry.name);
                          setDraft(entry.value ?? "");
                        }}
                      >
                        Edit
                      </Button>
                      {entry.source === "TOPIC_CONFIG" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          aria-label={`Reset ${entry.name}`}
                          onClick={() => void apply({ [entry.name]: null }, `Reset ${entry.name} to its default.`)}
                        >
                          Reset
                        </Button>
                      )}
                    </>
                  )
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="New config name"
          placeholder="config.name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className={`${fieldClass} w-56`}
        />
        <Input
          aria-label="New config value"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className={`${fieldClass} w-40`}
        />
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={newName.trim() === ""}
          onClick={() => {
            const name = newName.trim();
            void apply({ [name]: newValue }, `Set ${name}.`).then(() => {
              setNewName("");
              setNewValue("");
            });
          }}
        >
          Add override
        </Button>
      </div>
    </div>
  );
}
