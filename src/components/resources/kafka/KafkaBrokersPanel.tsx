"use client";

import { useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaClusterOverview } from "@/lib/resources/operations";
import { postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, Loading } from "./parts";

/** Cluster id, controller and the broker list. Read-only. */
export function KafkaBrokersPanel({ connection }: { connection: ResourceConnection }) {
  const read = useCallback(() => postKafka<KafkaClusterOverview>(connection, "cluster"), [connection]);
  const { data: cluster, error, reload: load } = useKafkaRead(read);

  return (
    <div data-testid="kafka-brokers" className="space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <span className="text-fg-muted">
          Cluster id <span className="font-mono text-fg">{cluster?.clusterId ?? "—"}</span>
        </span>
        <span className="text-fg-muted">
          Controller <span className="font-mono text-fg">{cluster?.controllerId ?? "—"}</span>
        </span>
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => void load()}>
          <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      <ErrorLine error={error} />
      {cluster === null ? (
        error === null && <Loading label="Reading the cluster…" />
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Broker</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Rack</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cluster.brokers.map((broker) => (
              <TableRow key={broker.nodeId} data-testid="kafka-broker-row">
                <TableCell className="font-mono">{broker.nodeId}</TableCell>
                <TableCell className="font-mono">{broker.host}</TableCell>
                <TableCell className="font-mono">{broker.port}</TableCell>
                <TableCell>{broker.rack ?? "—"}</TableCell>
                <TableCell>{broker.isController ? "Controller" : "Broker"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
