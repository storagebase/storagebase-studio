"use client";

import { KafkaWorkbench } from "@/components/storagebase/resources/kafka/KafkaWorkbench";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { SectionConnection } from "./connection-body";

/**
 * The Messaging page's workbench (StorageBase fork). The Kafka admin workbench — topics, produce,
 * consumer groups, brokers — is a fork-owned component; the section shell stays a thin adapter so
 * the section contract (`{connection, readOnly}`) does not depend on which family owns the viewer.
 *
 * The connection may be an upstream `kafka` seed (resolved through upstream `resolveConnection`)
 * or a fork resource connection (resolved through the fork store/seed). The page only holds ids and
 * non-secret fields; the workbench's routes resolve credentials server-side.
 */
export function SectionKafkaWorkbench({
  connection,
  readOnly = false,
}: {
  connection: SectionConnection;
  readOnly?: boolean;
}) {
  return <KafkaWorkbench connection={connection as ResourceConnection} readOnly={readOnly} />;
}
