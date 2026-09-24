import { describe, test, expect, mock, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createMockRequest } from "../helpers/mock-next";
import { sqliteDriver, type SqliteDatabaseLike } from "@/lib/fork-store/sqlite-driver";

/**
 * Threat: a resource action's CONTENT reaching the audit trail. Every resource read and write is
 * audited now (StorageBase fork), and the events travel to three places — the ring buffer the
 * admin API serves, the authoritative `libredb.audit.v1` stdout line, and the durable store's
 * `storagebase_audit_events` rows — so a secret value, a blob's bytes, a queue message's body and
 * a Kafka record's key, value or headers must reach none of them. Each route below is driven
 * through the real handler, the real emitter, the real durable sink and a real SQLite store.
 *
 * What the events MAY carry is asserted too, so a test that passes because nothing was recorded
 * cannot pass here: every action must leave exactly one event per read, with its address.
 */

const SECRET_VALUE = "s3cr3t-vault-value";
const BLOB_CONTENT = "blob-body-confidential";
const MESSAGE_BODY = "queue-body-confidential";
const KAFKA_VALUE = "kafka-value-confidential";
const KAFKA_KEY = "kafka-key-confidential";
const KAFKA_HEADER = "kafka-header-confidential";
const LEAKS = [SECRET_VALUE, BLOB_CONTENT, MESSAGE_BODY, KAFKA_VALUE, KAFKA_KEY, KAFKA_HEADER];

const memory = new Database(":memory:");
mock.module("@/lib/fork-store/sqlite-driver", () => ({
  sqliteDriver,
  openSqliteDriver: async () => sqliteDriver(memory as unknown as SqliteDatabaseLike),
}));

mock.module("@/lib/api/require-session", () => ({
  guardRoute: mock(async () => ({ session: { role: "user", username: "alice" } })),
  auditRoleDenial: mock(() => {}),
}));

const body = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const provider = {
  // blob
  listBuckets: async () => ({ nodes: [], truncated: false }),
  listObjects: async () => ({ nodes: [], truncated: false }),
  readBlobMeta: async (bucket: string, name: string) => ({
    id: `${bucket}/${name}`,
    name,
    sizeBytes: BLOB_CONTENT.length,
    lastModified: null,
    contentType: "text/plain",
  }),
  downloadBlob: async () => ({ body: body(BLOB_CONTENT), contentType: "text/plain", sizeBytes: BLOB_CONTENT.length }),
  previewBlob: async () => ({ kind: "text", text: BLOB_CONTENT, truncated: false, contentType: "text/plain" }),
  // messaging
  listDestinations: async () => ({ nodes: [], truncated: false }),
  browseMessages: async () => ({
    messages: [
      { id: "q/0", parentId: "q", kind: "message", name: "#0", hasChildren: false, meta: { body: MESSAGE_BODY } },
    ],
    truncated: false,
  }),
  // vault
  listMounts: async () => ({ nodes: [], truncated: false }),
  listSecrets: async () => ({ nodes: [], truncated: false }),
  readSecret: async () => ({ value: SECRET_VALUE, version: "1" }),
  // kafka
  describeCluster: async () => ({ clusterId: "c", controllerId: 1, brokers: [] }),
  readMessages: async () => ({
    messages: [
      {
        partition: 0,
        offset: "7",
        timestamp: "2026-09-24T10:00:00.000Z",
        key: KAFKA_KEY,
        value: KAFKA_VALUE,
        keyEncoding: "utf8",
        valueEncoding: "utf8",
        valueTruncated: false,
        valueBytes: KAFKA_VALUE.length,
        headers: { trace: KAFKA_HEADER },
      },
    ],
    truncated: false,
  }),
  // provider surface
  listNodes: async () => ({
    nodes: [
      { id: "n", parentId: null, kind: "secret", name: "api-token", hasChildren: false, meta: { value: SECRET_VALUE } },
    ],
    truncated: false,
  }),
  getHealth: async () => ({ status: "healthy", message: SECRET_VALUE }),
  getCapabilities: () => ({
    category: "vault",
    defaultPort: 443,
    supportsSshTunnel: false,
    operations: ["tree", "blob.read", "blob.download", "message.browse", "secret.read", "kafka.inspect"],
  }),
  getLabels: () => ({ containerNoun: "Mounts", itemNoun: "Secrets" }),
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
};

mock.module("@/lib/resources/factory", () => ({
  createResourceProvider: mock(async () => provider),
  getOrCreateResourceProvider: mock(async () => provider),
  removeResourceProvider: mock(async () => undefined),
  clearResourceProviderCache: mock(() => undefined),
  getResourceProviderCacheStats: mock(() => ({ total: 0, connected: 0 })),
  testResourceConnection: mock(async () => ({ success: true, degraded: false, message: "Connected" })),
  setResourceFactoryClockForTest: mock(() => undefined),
  evictIdleResourceProviders: mock(() => undefined),
}));

const { getServerAuditBuffer } = await import("@/lib/audit");
const { installDurableAuditSink } = await import("@/lib/fork-store/audit-sink");
const { closeForkStore, getForkStore } = await import("@/lib/fork-store");

const connection = { id: "res-1", name: "Vault", type: "hashicorp-vault", createdAt: "2026-01-01T00:00:00.000Z" };

const cases: Array<[string, string, Record<string, unknown>, string]> = [
  ["tree", "tree", {}, "tree.list"],
  ["blob/preview", "blob/preview", { bucket: "b", name: "k.txt" }, "blob.preview"],
  ["blob/download", "blob/download", { bucket: "b", name: "k.txt" }, "blob.download"],
  ["blob/meta", "blob/meta", { bucket: "b", name: "k.txt" }, "blob.meta"],
  ["message/browse", "message/browse", { destination: "q" }, "message.browse"],
  ["health", "health", {}, "resource.health"],
  ["kafka/messages", "kafka/messages", { topic: "orders", seek: { mode: "earliest" } }, "kafka.messages.read"],
];

const savedProvider = process.env.STORAGE_PROVIDER;
let uninstall: () => void;

beforeAll(() => {
  process.env.STORAGE_PROVIDER = "sqlite";
  uninstall = installDurableAuditSink();
});

afterAll(async () => {
  uninstall();
  await closeForkStore();
  if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
  else process.env.STORAGE_PROVIDER = savedProvider;
});

async function storedRows(expected: number): Promise<string> {
  let rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 100 && rows.length < expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await getForkStore();
    rows = memory.prepare("SELECT * FROM storagebase_audit_events").all() as Array<Record<string, unknown>>;
  }
  expect(rows.length).toBe(expected);
  return JSON.stringify(rows);
}

describe("a resource action's content never reaches the audit trail", () => {
  beforeEach(async () => {
    getServerAuditBuffer().clear();
    await getForkStore();
    memory.prepare("DELETE FROM storagebase_audit_events").run();
  });

  test.each(cases)("%s", async (_label, route, fields, action) => {
    const { POST } = await import(`@/app/api/resources/${route}/route`);
    const log = spyOn(console, "log").mockImplementation(() => {});
    let lines: string[];
    try {
      const res = await POST(
        createMockRequest(`/api/resources/${route}`, { method: "POST", body: { connection, ...fields } }) as never,
      );
      expect(res.status).toBe(200);
      lines = log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }

    const events = getServerAuditBuffer().getAll();
    expect(events.map((event) => event.action)).toEqual([action]);
    expect(events[0]).toMatchObject({
      type: "resource_operation",
      result: "success",
      user: "alice",
      engine: "hashicorp-vault",
    });
    const auditLines = lines.filter((line) => line.includes('"schema":"libredb.audit.v1"'));
    expect(auditLines).toHaveLength(1);

    const rows = await storedRows(1);
    for (const destination of [JSON.stringify(events), auditLines[0], rows]) {
      for (const leak of LEAKS) expect(destination).not.toContain(leak);
    }
  });

  test("secret/read records the path and never the value", async () => {
    const { POST } = await import("@/app/api/resources/secret/read/route");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await POST(
        createMockRequest("/api/resources/secret/read", {
          method: "POST",
          body: { connection, path: "kv/api-token" },
        }) as never,
      );
      expect(res.status).toBe(200);
      const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
      const rows = await storedRows(2);
      const buffered = JSON.stringify(getServerAuditBuffer().getAll());
      expect(buffered).toContain("kv/api-token");
      for (const destination of [buffered, lines, rows]) expect(destination).not.toContain(SECRET_VALUE);
    } finally {
      log.mockRestore();
    }
  });
});
