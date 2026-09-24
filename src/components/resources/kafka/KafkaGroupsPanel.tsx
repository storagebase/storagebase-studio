"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { KafkaConsumerGroupListing } from "@/lib/resources/operations";
import { postKafka } from "./kafka-api";
import { useKafkaRead } from "./use-kafka-read";
import { ErrorLine, fieldClass, Loading } from "./parts";

/**
 * Consumer groups with state, members and total lag. The studio's own peek
 * groups are internal: hidden unless asked for, the internal-topic ruling.
 */
export function KafkaGroupsPanel({
  connection,
  onOpenGroup,
}: {
  connection: ResourceConnection;
  onOpenGroup: (groupId: string) => void;
}) {
  const read = useCallback(() => postKafka<KafkaConsumerGroupListing>(connection, "groups"), [connection]);
  const { data: listing, error, reload: load } = useKafkaRead(read);
  const [filter, setFilter] = useState("");
  const [showInternal, setShowInternal] = useState(false);

  const needle = filter.trim().toLowerCase();
  const visible = (listing?.groups ?? []).filter(
    (group) => (showInternal || !group.internal) && group.groupId.toLowerCase().includes(needle),
  );

  return (
    <div data-testid="kafka-groups" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter consumer groups"
          placeholder="Filter consumer groups"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={`${fieldClass} w-56`}
        />
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
          Show studio peek groups
        </label>
        <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => void load()}>
          <RefreshCw strokeWidth={1.5} className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
      <ErrorLine error={error} />
      {listing === null ? (
        error === null && <Loading label="Listing consumer groups…" />
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No consumer groups match.</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Total lag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((group) => (
              <TableRow key={group.groupId} data-testid="kafka-group-row">
                <TableCell>
                  <button
                    type="button"
                    onClick={() => onOpenGroup(group.groupId)}
                    className="font-medium text-fg hover:text-brand text-left"
                  >
                    {group.groupId}
                  </button>
                </TableCell>
                <TableCell>{group.state}</TableCell>
                <TableCell className="text-fg-subtle">
                  {[group.protocolType, group.protocol].filter((part) => part !== "").join(" / ") || "—"}
                </TableCell>
                <TableCell className="text-right font-mono">{group.members}</TableCell>
                <TableCell className="text-right font-mono" title={group.lagError ?? undefined}>
                  {group.totalLag ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {listing?.lagTruncated && <p className="text-xs text-fg-subtle">Lag is measured for the first 50 groups only.</p>}
    </div>
  );
}
