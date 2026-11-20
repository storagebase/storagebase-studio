import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { flushStoragebaseAuditEvents, resetStoragebaseAuditSinkForTests } from "@/storagebase/audit/sink";
import { auditedResourceRead, beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import { closeForkStore } from "@/storagebase/store";
import { sqliteDriver, type SqliteDatabaseLike } from "@/storagebase/store/sqlite-driver";
import { ResourceNotFoundError } from "@/storagebase/resources/errors";

/**
 * Threat: a resource action's CONTENT reaching the fork audit trail. The fork's resource helpers
 * (phase 2's routes will call them) record every read and write as a `resource_operation` event
 * with two destinations — the durable `storagebase_audit_events` row and the
 * `storagebase.audit.v1` stdout line — so a secret value, a blob's bytes or a message body must
 * reach neither. What the events MAY carry is asserted too, so a case that passes because
 * nothing was recorded cannot pass here: the address, the counts, and the correlation id are all
 * expected.
 *
 * The old fork's resource-audit-redaction suite drove the resource ROUTES; those arrive in phase
 * 2, so this file drives the helpers themselves end to end — the real sink, the real store SQL
 * over an in-memory SQLite driver, no module mocks between the call and the trail.
 */

const SECRET_VALUE = "TOP-SECRET-VALUE";
const BLOB_CONTENT = "blob-body-confidential";
const MESSAGE_BODY = "queue-body-confidential";
const LEAKS = [SECRET_VALUE, BLOB_CONTENT, MESSAGE_BODY];

const memory = new Database(":memory:");
mock.module("@/storagebase/store/sqlite-driver", () => ({
  sqliteDriver,
  openSqliteDriver: async () => sqliteDriver(memory as unknown as SqliteDatabaseLike),
}));

const savedProvider = process.env.STORAGE_PROVIDER;
// Migrated once, through the store itself (the driver mock answers), so the table every case
// reads and cleans exists before the first case runs.
process.env.STORAGE_PROVIDER = "sqlite";
await (await import("@/storagebase/store")).getForkStore();

let logSpy: ReturnType<typeof spyOn>;

const request = { headers: new Headers({ "x-forwarded-for": "203.0.113.5", "user-agent": "test-agent/1.0" }) };
const connection = { id: "res-1", name: "Blob store", type: "azure-blob" };
const ctx = { session: { role: "user", username: "alice" }, route: "api/sb/resources/tree", connection };

/** Lets the tap's fire-and-forget chain land, then drains both destinations at once: the
 * shutdown-style flush prints and writes everything queued, whatever timer set this process's
 * sink ended up pinned to (the seams module pins the real pair when it loaded first). */
async function flushedTrail(): Promise<{ rows: string; lines: string[] }> {
  for (let i = 0; i < 3000; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round lets the work the one before it started run.
    await Promise.resolve();
  }
  await flushStoragebaseAuditEvents();
  const rows = JSON.stringify(memory.prepare("SELECT * FROM storagebase_audit_events").all());
  const lines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
  return { rows, lines };
}

beforeEach(() => {
  resetStoragebaseAuditSinkForTests();
  process.env.STORAGE_PROVIDER = "sqlite";
  logSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  memory.prepare("DELETE FROM storagebase_audit_events").run();
});

afterEach(() => {
  logSpy.mockRestore();
  resetStoragebaseAuditSinkForTests();
  memory.prepare("DELETE FROM storagebase_audit_events").run();
});

afterAll(async () => {
  await closeForkStore();
  if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
  else process.env.STORAGE_PROVIDER = savedProvider;
});

describe("a resource action's content never reaches the audit trail", () => {
  test("a read's event records the address and the counts, never the result it counted", async () => {
    const result = {
      nodes: [
        { id: "b/k.txt", meta: { body: BLOB_CONTENT } },
        { id: "b/k2.txt", meta: { body: MESSAGE_BODY } },
      ],
      truncated: false,
    };
    const answered = await auditedResourceRead(
      ctx,
      request,
      "tree.list",
      "azure-blob:bucket-a",
      async () => result,
      (page) => ({ itemsListed: page.nodes.length, truncated: page.truncated }),
    );
    expect(answered).toBe(result);

    const { rows, lines } = await flushedTrail();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({
      schema: "storagebase.audit.v1",
      event: "resource_operation",
      action: "tree.list",
      route: "azure-blob:bucket-a",
      outcome: "success",
      actor: "alice",
      connection_id: "res-1",
      counts: { itemsListed: 2, truncated: false },
    });
    for (const destination of [rows, lines.join("\n")]) {
      for (const leak of LEAKS) expect(destination).not.toContain(leak);
    }
  });

  test("a write's decision and outcome carry the target and the correlation id, never a value", async () => {
    const correlationId = beginResourceWrite(
      "alice",
      "secret.write",
      "azure-key-vault:vault/secret/db-password",
      request,
      connection,
    );
    endResourceWrite(
      "alice",
      "secret.write",
      "azure-key-vault:vault/secret/db-password",
      correlationId,
      new ResourceNotFoundError("gone"),
      request,
      connection,
    );

    const { rows, lines } = await flushedTrail();
    expect(lines).toHaveLength(2);
    const [decision, outcome] = lines.map((line) => JSON.parse(line));
    expect(decision).toMatchObject({
      event: "resource_operation",
      action: "secret.write",
      route: "azure-key-vault:vault/secret/db-password",
      outcome: "success",
      correlation_id: correlationId,
    });
    expect(outcome).toMatchObject({ outcome: "failure", reason: "resource_not_found" });
    expect(rows).toContain("azure-key-vault:vault/secret/db-password");
    for (const destination of [rows, lines.join("\n")]) {
      for (const leak of LEAKS) expect(destination).not.toContain(leak);
    }
  });

  test("a failed read records the reason and rethrows, with nothing of the content", async () => {
    await expect(
      auditedResourceRead(ctx, request, "blob.preview", "azure-blob:bucket-a/k.txt", async () => {
        throw new Error(`preview failed: ${SECRET_VALUE}`);
      }),
    ).rejects.toThrow();

    const { rows, lines } = await flushedTrail();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: "failure", reason: "resource_failed" });
    for (const destination of [rows, lines.join("\n")]) expect(destination).not.toContain(SECRET_VALUE);
  });
});
