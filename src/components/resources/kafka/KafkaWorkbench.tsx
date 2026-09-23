"use client";

import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KafkaIcon } from "@/components/resources/resource-icons";
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
 * The Kafka workbench — what selecting a Kafka connection opens in the main
 * area, in place of the resource tree + message dialog the other messaging
 * types use. Three areas: topics (list, detail, messages, config), consumer
 * groups (list, detail, offset reset) and the broker overview.
 *
 * The shell mounts it keyed by connection id, so switching clusters starts
 * from a clean slate rather than showing one cluster's topic on another.
 */
export function KafkaWorkbench({
  connection,
  onClose,
  onEditConnection,
}: {
  connection: ResourceConnection;
  onClose: () => void;
  onEditConnection?: (connection: ResourceConnection) => void;
}) {
  const [section, setSection] = useState<Section>("topics");
  const [topic, setTopic] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);

  return (
    <div data-testid="kafka-workbench" className="h-full flex flex-col bg-surface text-fg">
      <header className="h-12 px-4 flex items-center gap-2 border-b border-hairline shrink-0">
        <KafkaIcon className="w-4 h-4 text-hue-violet" />
        <span className="text-sm font-medium truncate">{connection.name}</span>
        <span className="text-xs font-mono text-fg-subtle truncate">{connection.endpoint}</span>
        <div className="ml-auto flex items-center gap-1">
          {onEditConnection && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              aria-label="Edit connection"
              onClick={() => onEditConnection(connection)}
            >
              <Pencil strokeWidth={1.5} className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-xs" aria-label="Close workbench" onClick={onClose}>
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </Button>
        </div>
      </header>
      <div className="px-4 pt-2 shrink-0">
        <SectionTabs label="Kafka sections" tabs={SECTIONS} active={section} onChange={setSection} />
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {section === "topics" &&
          (topic === null ? (
            <KafkaTopicsPanel connection={connection} onOpenTopic={setTopic} />
          ) : (
            <KafkaTopicDetail
              key={topic}
              connection={connection}
              topic={topic}
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
              onBack={() => setGroupId(null)}
              onDeleted={() => setGroupId(null)}
            />
          ))}
        {section === "brokers" && <KafkaBrokersPanel connection={connection} />}
      </div>
    </div>
  );
}
