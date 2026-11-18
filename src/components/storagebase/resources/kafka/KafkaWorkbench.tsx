"use client";

import { useState } from "react";
import type { ResourceConnection } from "@/storagebase/resources/types";
import { SectionTabs } from "./parts";
import { KafkaBrokersPanel } from "./KafkaBrokersPanel";
import { KafkaGroupsPanel } from "./KafkaGroupsPanel";
import { KafkaGroupDetail } from "./KafkaGroupDetail";
import { KafkaTopicsPanel } from "./KafkaTopicsPanel";
import { KafkaTopicDetail } from "./KafkaTopicDetail";

type Section = "topics" | "groups" | "brokers";

const SECTIONS = [
  { id: "topics", label: "Topics" },
  { id: "groups", label: "Consumer groups" },
  { id: "brokers", label: "Brokers" },
] as const;

/** The Kafka workbench: topics, consumer groups and brokers over one upstream connection. */
export function KafkaWorkbench({
  connection,
  readOnly = false,
}: {
  connection: ResourceConnection;
  readOnly?: boolean;
}) {
  const [section, setSection] = useState<Section>("topics");
  const [topic, setTopic] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);

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
            />
          ))}
        {section === "groups" &&
          (group === null ? (
            <KafkaGroupsPanel connection={connection} onOpenGroup={setGroup} />
          ) : (
            <KafkaGroupDetail
              key={group}
              connection={connection}
              groupId={group}
              readOnly={readOnly}
              onBack={() => setGroup(null)}
            />
          ))}
        {section === "brokers" && <KafkaBrokersPanel connection={connection} />}
      </div>
    </div>
  );
}
