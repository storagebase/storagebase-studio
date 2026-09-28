import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { UserConnectionFamily } from "./ids";

/**
 * `connection_secrets_migrated` (StorageBase fork): the one-time move of a user's connection
 * secrets out of a synced collection or a browser into the server's write-only store. It carries
 * the COUNT of connections moved and never a field name, value or connection id, so the trail
 * records that the move happened without describing what was moved. Isolated: a broken sink must
 * not undo a migration that has already been written.
 */
export function auditSecretsMigrated(username: string, family: UserConnectionFamily, count: number): void {
  if (count === 0) return;
  try {
    emitAuditEvent({
      type: "connection_secrets_migrated",
      action: "migrated",
      target: family,
      user: username,
      result: "success",
      details: `${count} connection(s)`,
    });
  } catch (auditError) {
    logger.error("Failed to record connection_secrets_migrated audit event", auditError, {
      route: "user-connections",
    });
  }
}
