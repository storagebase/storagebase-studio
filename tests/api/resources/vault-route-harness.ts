import { mock } from "bun:test";
import { createMockRequest } from "../../helpers/mock-next";
import type { VaultObjectSummary, VaultObjectType } from "@/lib/resources/operations";

/**
 * Shared doubles for the vault route tests. Importing this module registers
 * the process-wide mocks (the guard, the audit sink, the provider factory and
 * the fork store), so each test file imports it BEFORE the routes. The guard
 * is doubled rather than @/lib/auth (docs/BACKLOG.md D85 pins that mock).
 *
 * The fake provider is a full `VaultWorkbenchOperations` over an in-memory
 * vault, and records every call — including the arguments carrying values,
 * so the security test can prove those arguments never reach an audit event.
 */

export const session: { current: { role: string; username: string } | null } = {
  current: { role: "admin", username: "admin" },
};

mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => {
    if (session.current === null) {
      const { NextResponse } = await import("next/server");
      return { response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
    }
    return { session: session.current };
  }),
  auditRoleDenial: mock(() => {}),
}));

export const auditEvents: Array<Record<string, unknown>> = [];

mock.module("@/lib/audit", () => ({
  emitAuditEvent: mock((event: Record<string, unknown>) => {
    auditEvents.push(event);
    return { id: "audit-1", ...event };
  }),
}));

export const settings = new Map<string, unknown>();
export const store: { mode: "store" | "none" | "broken" } = { mode: "store" };

mock.module("@/lib/fork-store", () => ({
  getForkStore: mock(async () => {
    if (store.mode === "broken") throw new Error("database is locked");
    if (store.mode === "none") return null;
    return {
      getSetting: async (key: string) => (settings.has(key) ? settings.get(key) : null),
      setSetting: async (key: string, value: unknown) => {
        settings.set(key, value);
      },
    };
  }),
}));

export const providerCalls: Array<{ method: string; args: unknown[] }> = [];

function summary(type: VaultObjectType, name: string): VaultObjectSummary {
  return {
    type,
    name,
    enabled: true,
    createdOn: null,
    updatedOn: null,
    expiresOn: null,
    notBefore: null,
    tags: {},
    contentType: null,
    keyType: null,
    keySize: null,
    curve: null,
    subject: null,
    issuer: null,
    thumbprint: null,
  };
}

export const objects: Record<VaultObjectType, string[]> = { secret: [], key: [], certificate: [] };
export const deletedObjects: Record<VaultObjectType, string[]> = { secret: [], key: [], certificate: [] };

export const FULL_FLAGS = [
  "tree",
  "secret.read",
  "secret.write",
  "secret.delete",
  "vault.secrets",
  "vault.keys",
  "vault.certificates",
  "vault.secret.reveal",
  "vault.secret.write",
  "vault.secret.metadata",
  "vault.key.write",
  "vault.certificate.write",
  "vault.delete",
  "vault.soft-delete",
];

export const flags: { current: string[] } = { current: FULL_FLAGS };

function track(method: string, args: unknown[]) {
  providerCalls.push({ method, args });
}

export const fakeProvider = {
  getCapabilities: () => ({ category: "vault", defaultPort: 443, supportsSshTunnel: false, operations: flags.current }),
  getLabels: () => ({ containerNoun: "Vault", itemNoun: "Secrets" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  listNodes: async () => ({
    nodes: objects.secret.map((name) => ({
      id: `secret/${name}`,
      parentId: null,
      kind: "secret",
      name,
      hasChildren: false,
    })),
    truncated: false,
  }),
  listMounts: async () => ({ nodes: [], truncated: false }),
  listSecrets: async () => ({ nodes: [], truncated: false }),
  readSecret: async (path: string) => {
    track("readSecret", [path]);
    return { name: path, value: "legacy-value", metadata: null };
  },
  writeSecret: async (...args: unknown[]) => track("writeSecret", args),
  deleteSecret: async (...args: unknown[]) => track("deleteSecret", args),
  listVaultObjects: async (type: VaultObjectType) => {
    track("listVaultObjects", [type]);
    return { objects: objects[type].map((name) => summary(type, name)), truncated: false };
  },
  describeVaultObject: async (type: VaultObjectType, name: string) => {
    track("describeVaultObject", [type, name]);
    return {
      ...summary(type, name),
      version: "v1",
      recoveryLevel: null,
      keyOperations: [],
      versions: [],
      versionsTruncated: false,
    };
  },
  revealSecret: async (name: string, version?: string) => {
    track("revealSecret", [name, version]);
    return { name, value: "TOP-SECRET-VALUE", version: version ?? "v1" };
  },
  saveSecret: async (...args: unknown[]) => track("saveSecret", args),
  createKey: async (...args: unknown[]) => track("createKey", args),
  importCertificate: async (...args: unknown[]) => track("importCertificate", args),
  deleteVaultObject: async (...args: unknown[]) => track("deleteVaultObject", args),
  listDeletedVaultObjects: async (type: VaultObjectType) => {
    track("listDeletedVaultObjects", [type]);
    return deletedObjects[type].map((name) => ({ type, name, deletedOn: null, scheduledPurgeDate: null }));
  },
  recoverDeletedVaultObject: async (...args: unknown[]) => track("recoverDeletedVaultObject", args),
  purgeDeletedVaultObject: async (...args: unknown[]) => track("purgeDeletedVaultObject", args),
};

export const factory: { provider: object } = { provider: fakeProvider };

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => factory.provider),
  getOrCreateResourceProvider: mock(async () => factory.provider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

export const connection = {
  id: "res-v",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "example",
  tenantId: "t",
  clientId: "c",
  clientSecret: "client-credential",
};

export const EXCLUSION_KEY = "vault-exclusions:azure-key-vault:https://example.vault.azure.net";

export function resetHarness() {
  session.current = { role: "admin", username: "admin" };
  auditEvents.length = 0;
  providerCalls.length = 0;
  settings.clear();
  store.mode = "store";
  flags.current = FULL_FLAGS;
  factory.provider = fakeProvider;
  objects.secret = ["db-password", "hidden-secret"];
  objects.key = ["signing"];
  objects.certificate = ["site-cert"];
  deletedObjects.secret = ["old-secret", "hidden-old"];
  deletedObjects.key = [];
  deletedObjects.certificate = [];
}

export function request(path: string, body: Record<string, unknown>, method = "POST") {
  return createMockRequest(path, {
    method,
    body: { connection, ...body },
    headers: { "user-agent": "vault-test-agent", "x-forwarded-for": "203.0.113.7" },
  }) as never;
}
