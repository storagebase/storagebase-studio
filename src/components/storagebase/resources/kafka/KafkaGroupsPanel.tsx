"use client";

import { useCallback, useState } from "react";
import type { ResourceConnection } from "@/storagebase/resources/types";
import type { KafkaConsumerGroupListing, KafkaGroupLag } from "@/storagebase/resources/operations";
import { postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, Loading } from "./parts";

/** Consumer group list; lag is measured for the rows on screen, best effort. */
export function KafkaGroupsPanel({
  connection,
  onOpenGroup,
}: {
  connection: ResourceConnection;
  onOpenGroup: (group: string) => void;
}) {
  const read = useCallback(() => postKafka<KafkaConsumerGroupListing>(connection, "groups"), [connection]);
  const { data, error, reload } = useKafkaRead(read);
  const [lags, setLags] = useState<Record<string, KafkaGroupLag>>({});
  const [lagError, setLagError] = useState<string | null>(null);

  const loadLag = useCallback(async () => {
    const ids = (data?.groups ?? []).slice(0, 25).map((group) => group.groupId);
    if (ids.length === 0) return;
    try {
      const answer = await postKafka<{ lags: Record<string, KafkaGroupLag> }>(connection, "groups/lag", {
        groupIds: ids,
      });
      setLags(answer.lags);
      setLagError(null);
    } catch (error) {
      setLagError(error instanceof Error ? error.message : String(error));
    }
  }, [connection, data]);
  const refresh = useCallback(async () => {
    await loadLag().catch(() => undefined);
    await reload();
  }, [loadLag, reload]);

  return (
    <div data-testid="kafka-groups" className="space-y-2">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium">Consumer groups</h2>
        <button type="button" onClick={() => void refresh()} className="text-xs text-fg-muted hover:text-fg">
          Refresh
        </button>
      </div>
      <ErrorLine error={error ?? lagError} />
      {data === null ? (
        error === null && <Loading label="Listing consumer groups…" />
      ) : data.groups.length === 0 ? (
        <p className="text-xs text-fg-muted">No consumer groups.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">Group</th>
              <th className="text-left">State</th>
              <th className="text-right">Members</th>
              <th className="text-right">Lag</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <tr key={group.groupId} data-testid="kafka-group-row">
                <td>
                  <button
                    type="button"
                    onClick={() => onOpenGroup(group.groupId)}
                    className="font-medium hover:text-brand"
                  >
                    {group.groupId}
                  </button>
                  {group.internal && <span className="ml-2 text-fg-subtle">internal</span>}
                </td>
                <td>{group.state}</td>
                <td className="text-right font-mono">{group.members}</td>
                <td className="text-right font-mono">{lags[group.groupId]?.totalLag ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
