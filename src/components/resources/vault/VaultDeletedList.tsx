"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceConnection } from "@/lib/resources/types";
import type { VaultDeletedObject, VaultObjectType } from "@/lib/resources/operations";
import { errorText } from "../kafka/kafka-api";
import { ConfirmByName, ErrorLine, Loading, Notice } from "../kafka/parts";
import { useKafkaRead } from "../kafka/use-kafka-read";
import { formatDate, postVault } from "./vault-api";

/**
 * Soft-deleted objects of one type: when each was deleted and when the vault
 * purges it, with Recover and a typed-name Purge. Purge is the only
 * irreversible action in the workbench, and says so.
 */
export function VaultDeletedList({ connection, type }: { connection: ResourceConnection; type: VaultObjectType }) {
  const read = useCallback(
    () => postVault<{ deleted: VaultDeletedObject[] }>(connection, "deleted", { type }),
    [connection, type],
  );
  const { data, error: readError, reload } = useKafkaRead(read);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);

  const act = async (route: string, name: string, done: string, payload: Record<string, unknown> = {}) => {
    setError(null);
    setNotice(null);
    try {
      await postVault(connection, route, { type, name, ...payload });
      setNotice(done);
      setPurging(null);
      await reload();
    } catch (actError) {
      setError(errorText(actError));
    }
  };

  return (
    <div data-testid="vault-deleted" className="space-y-3">
      <ErrorLine error={error ?? readError} />
      <Notice notice={notice} />
      {data === null ? (
        readError === null && <Loading label="Listing deleted items…" />
      ) : data.deleted.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No deleted items.</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Deleted</TableHead>
              <TableHead>Scheduled purge</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.deleted.map((item) => (
              <TableRow key={item.name} data-testid="vault-deleted-row">
                <TableCell className="font-mono break-all">{item.name}</TableCell>
                <TableCell className="font-mono">{formatDate(item.deletedOn)}</TableCell>
                <TableCell className="font-mono">{formatDate(item.scheduledPurgeDate)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {purging === item.name ? (
                    <ConfirmByName
                      name={item.name}
                      action="Purge"
                      consequence={`Purging permanently deletes ${item.name} and cannot be undone.`}
                      onConfirm={() => act("deleted/purge", item.name, `Purged ${item.name}.`, { confirm: item.name })}
                    />
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => void act("deleted/recover", item.name, `Recovered ${item.name}.`)}
                      >
                        Recover
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs text-danger"
                        onClick={() => setPurging(item.name)}
                      >
                        Purge…
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
