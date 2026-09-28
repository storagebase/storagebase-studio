"use client";

import { useState } from "react";
import type { ResourceConnection } from "@/lib/resources/types";
import { SectionTabs } from "./parts";
import { KafkaBrokersPanel } from "./KafkaBrokersPanel";
import { KafkaTopicsPanel } from "./KafkaTopicsPanel";
import { KafkaTopicDetail } from "./KafkaTopicDetail";
import { KafkaGroupsPanel } from "./KafkaGroupsPanel";
import { KafkaGroupDetail } from "./KafkaGroupDetail";

type Section = "topics" | "groups" | "brokers";

const SECTIONS = [
  { id: "topics", label: "Topics" },
  { id: "groups", label: "Consumer groups" },
  { id: "brokers", label: "Brokers" },
] as const;

/**
 * The Kafka workbench — what a Kafka connection opens full-page on the
 * Messaging page, in place of the resource tree + message viewer the other
 * messaging types use. Three areas: topics (list, detail, messages, config),
 * consumer groups (list, detail, offset reset) and the broker overview. The
 * page header names the connection; this owns everything below it.
 *
 * The page mounts it keyed by connection id, so switching clusters starts
 * from a clean slate rather than showing one cluster's topic on another.
 * `readOnly` (a managed connection granted read) withholds every write —
 * create, delete, partitions, config, produce, offset reset — and keeps reads.
 */
export function KafkaWorkbench({
  connection,
  readOnly = false,
}: {
  connection: ResourceConnection;
  readOnly?: boolean;
}) {
  const [section, setSection] = useState<Section>("topics");
  const [topic, setTopic] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);

  return (
    <div data-testid="kafka-workbench" className="h-full flex flex-col bg-surface text-fg">
      <div className="px-4 pt-2 shrink-0">
        <SectionTabs label="Kafka sections" tabs={SECTIONS} active={section} onChange={setSection} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {section === "topics" &&
          (topic === null ? (
            <KafkaTopicsPanel connection={connection} onOpenTopic={setTopic} readOnly={readOnly} />
          ) : (
            <KafkaTopicDetail
              key={topic}
              connection={connection}
              topic={topic}
              readOnly={readOnly}
              onBack={() => setTopic(null)}
              onDeleted={() => setTopic(null)}
            />
          ))}
        {section === "groups" &&
          (groupId === null ? (
            <KafkaGroupsPanel connection={connection} onOpenGroup={setGroupId} />
          ) : (
            <KafkaGroupDetail
              key={groupId}
              connection={connection}
              groupId={groupId}
              readOnly={readOnly}
              onBack={() => setGroupId(null)}
              onDeleted={() => setGroupId(null)}
            />
          ))}
        {section === "brokers" && <KafkaBrokersPanel connection={connection} />}
      </div>
    </div>
  );
}
