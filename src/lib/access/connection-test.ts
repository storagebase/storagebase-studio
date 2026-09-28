import { createDatabaseProvider, withOneShotTunnel } from "@/lib/db/factory";
import { testResourceConnection } from "@/lib/resources/factory";
import "@/lib/resources/providers";
import type { DatabaseConnection } from "@/lib/types";
import type { ResourceConnection } from "@/lib/resources/types";
import { decryptConnections, decryptResourceConnections } from "@/lib/storage/connection-secrets";
import type { ManagedConnectionKind } from "./types";

/**
 * "Test connection" for the admin's managed-connection form (StorageBase fork): the configuration
 * as it WOULD be saved — the submitted fields with every blank secret filled from the stored record
 * — opened once and closed, never cached. Stored secrets are still sealed at this point; they are
 * opened here, on the server, and the answer carries only whether it worked and the server's own
 * sentence.
 */

export interface ConnectionTestResult {
  success: boolean;
  degraded?: boolean;
  message: string;
  latencyMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function testDatabase(connection: DatabaseConnection): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    return await withOneShotTunnel(connection, async (effective) => {
      const provider = await createDatabaseProvider(effective, { queryTimeout: 10000 });
      try {
        await provider.connect();
        return { success: true, message: "Connected", latencyMs: Date.now() - started };
      } finally {
        await provider.disconnect().catch(() => undefined);
      }
    });
  } catch (error) {
    return { success: false, message: errorMessage(error) };
  }
}

export async function testManagedConfig(
  kind: ManagedConnectionKind,
  type: string,
  name: string,
  config: Record<string, unknown>,
): Promise<ConnectionTestResult> {
  const carrier = { ...config, id: "admin-test", name, type, createdAt: new Date().toISOString() };
  if (kind === "database") {
    const [opened] = decryptConnections([carrier as unknown as DatabaseConnection]).connections;
    return testDatabase({ ...opened, createdAt: new Date() });
  }
  const [opened] = decryptResourceConnections([carrier as unknown as ResourceConnection]).resourceConnections;
  return testResourceConnection(opened);
}
