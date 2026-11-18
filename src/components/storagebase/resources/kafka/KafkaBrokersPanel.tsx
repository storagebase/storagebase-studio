"use client";

import { useCallback } from "react";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaClusterOverview } from "@/storagebase/resources/operations";
import { postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, Loading } from "./parts";

/** Cluster id, controller and the broker list — one read, no writes. */
export function KafkaBrokersPanel({ connection }: { connection: ResourceConnection }) {
  const read = useCallback(() => postKafka<KafkaClusterOverview>(connection, "cluster"), [connection]);
  const { data, error } = useKafkaRead(read);
  return (
    <div data-testid="kafka-brokers" className="space-y-2">
      <h2 className="text-sm font-medium">Brokers</h2>
      <ErrorLine error={error} />
      {data === null ? (
        error === null && <Loading label="Describing the cluster…" />
      ) : (
        <div>
          <p className="text-xs text-fg-muted">
            Cluster {data.clusterId} · controller {data.controllerId ?? "unknown"}
          </p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Node</th>
                <th className="text-left">Host</th>
                <th className="text-left">Port</th>
                <th className="text-left">Rack</th>
              </tr>
            </thead>
            <tbody>
              {data.brokers.map((broker) => (
                <tr key={broker.nodeId} data-testid="kafka-broker-row">
                  <td>
                    {broker.nodeId}
                    {broker.isController ? " (controller)" : ""}
                  </td>
                  <td>{broker.host}</td>
                  <td>{broker.port}</td>
                  <td>{broker.rack ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
