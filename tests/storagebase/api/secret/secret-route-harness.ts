import { mock } from "bun:test";
import { NextResponse } from "next/server";
import { createMockRequest } from "../../../helpers/mock-next";
import { resetStoragebaseAuditSinkForTests, storagebaseBufferedAuditEvents } from "@/storagebase/audit/sink";
import type { ResourceNodePage } from "@/storagebase/resources/types";

/**
 * Shared doubles for the generic `/api/sb/secret/*` route tests. Importing this
 * module registers the process-wide mocks (the guard and the provider factory)
 * BEFORE the routes; the fork audit sink is real and its ring is reset per test.
 */
export const session: { current: { role: string; username: string } | null } = {
  current: { role: "admin", username: "admin" },
};

export const roleDenials: Array<Record<string, unknown>> = [];

mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => {
    if (session.current === null) {
      return {
        response: NextResponse.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 }),
      };
    }
    return { session: session.current };
  }),
  adminRequiredResponse: mock(() =>
    NextResponse.json({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" }, { status: 403 }),
  ),
  auditRoleDenial: mock((event: Record<string, unknown>) => {
    roleDenials.push(event);
  }),
}));

/** Every fork audit event the sink's ring holds, oldest first. */
export function auditEvents(): Record<string, unknown>[] {
  return storagebaseBufferedAuditEvents() as unknown as Record<string, unknown>[];
}

export const calls: Array<{ method: string; args: unknown[] }> = [];

function track(method: string, args: unknown[]): void {
  calls.push({ method, args });
}

export const flags: { current: string[] } = {
  current: ["tree", "secret.read", "secret.write", "secret.delete"],
};

export const listing: { page: ResourceNodePage } = {
  page: { nodes: [], truncated: false },
};

export const fakeProvider = {
  getCapabilities: () => ({
    category: "vault",
    defaultPort: 8200,
    supportsSshTunnel: false,
    operations: flags.current,
  }),
  getLabels: () => ({ containerNoun: "Mounts", itemNoun: "Secrets" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  listMounts: async () => ({ nodes: [], truncated: false }),
  listSecrets: async (mount: string, prefix: string | null) => {
    track("listSecrets", [mount, prefix]);
    return listing.page;
  },
  readSecret: async (path: string) => ({ name: path, value: "value", metadata: null }),
  writeSecret: async (...args: unknown[]) => track("writeSecret", args),
  deleteSecret: async (...args: unknown[]) => track("deleteSecret", args),
};

export const factory: { provider: object } = { provider: fakeProvider };

mock.module("@/storagebase/resources/factory", () => ({
  createResourceProvider: mock(async () => factory.provider),
  getOrCreateResourceProvider: mock(async () => factory.provider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
  resourceConfigKey: mock(() => "mocked-config-key"),
}));

export const connection = {
  id: "res-v",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:8200",
  token: "root",
};

export function resetHarness(): void {
  resetStoragebaseAuditSinkForTests();
  session.current = { role: "admin", username: "admin" };
  roleDenials.length = 0;
  calls.length = 0;
  flags.current = ["tree", "secret.read", "secret.write", "secret.delete"];
  factory.provider = fakeProvider;
  listing.page = { nodes: [], truncated: false };
}

export function request(path: string, body: Record<string, unknown>) {
  return createMockRequest(path, {
    method: "POST",
    body: { connection, ...body },
    headers: { "user-agent": "secret-test-agent", "x-forwarded-for": "203.0.113.7" },
  }) as never;
}
