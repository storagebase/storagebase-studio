import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { installAccessStore } from "../../helpers/access-store";
import { memoryStorageProvider } from "../../helpers/memory-storage-provider";

/**
 * The user-connection routes (StorageBase fork): save, forget, test, migrate. Driven against the
 * real storage wrapper and a real SQLite fork store; only the session, the storage factory and the
 * two delegated test routes are stand-ins.
 */

let session: { username: string; role: string } | null = { username: "alice", role: "user" };
mock.module("@/lib/auth", () => ({ getSession: async () => session }));

const handle = installAccessStore();
let provider: unknown;
let storageOn = true;
mock.module("@/lib/storage/factory", () => ({
  getStorageProvider: async () => (storageOn ? provider : null),
  getStorageProviderType: () => (storageOn ? "sqlite" : "local"),
}));

const probes: Array<{ family: string; body: unknown }> = [];
mock.module("@/app/api/db/test-connection/route", () => ({
  POST: async (req: NextRequest) => {
    probes.push({ family: "database", body: await req.json() });
    return NextResponse.json({ success: true, latency: 3 });
  },
}));
mock.module("@/app/api/resources/test/route", () => ({
  POST: async (req: NextRequest) => {
    probes.push({ family: "resource", body: await req.json() });
    return NextResponse.json({ success: true, latencyMs: 4 });
  },
}));

const { withServerHeldSecrets } = await import("@/lib/user-connections/provider");
const userRoute = await import("@/app/api/connections/user/route");
const testRoute = await import("@/app/api/connections/user/test/route");
const migrateRoute = await import("@/app/api/connections/user/migrate/route");

function request(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PG = { id: "c1", name: "orders", type: "postgres", host: "db", port: 5432, user: "app", password: "pw-1" };

beforeEach(async () => {
  clearRateLimitState();
  await handle.reset();
  provider = withServerHeldSecrets(memoryStorageProvider());
  storageOn = true;
  session = { username: "alice", role: "user" };
  probes.length = 0;
});

describe("POST /api/connections/user", () => {
  test("saves and answers the row without its secret", async () => {
    const res = await userRoute.POST(request("/api/connections/user", { kind: "database", connection: PG }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("pw-1");
    expect(JSON.parse(text).connection.savedSecrets).toEqual(["password"]);
  });

  test("refuses no session, a bad body, a bad kind, and a deployment without server storage", async () => {
    session = null;
    expect((await userRoute.POST(request("/api/connections/user", { kind: "database", connection: PG }))).status).toBe(
      401,
    );
    session = { username: "alice", role: "user" };
    expect((await userRoute.POST(request("/api/connections/user", "not json"))).status).toBe(400);
    expect((await userRoute.POST(request("/api/connections/user", { kind: "blob", connection: PG }))).status).toBe(400);
    storageOn = false;
    expect((await userRoute.POST(request("/api/connections/user", { kind: "database", connection: PG }))).status).toBe(
      409,
    );
  });
});

describe("DELETE /api/connections/user", () => {
  test("forgets the stored secrets", async () => {
    await userRoute.POST(request("/api/connections/user", { kind: "database", connection: PG }));
    const res = await userRoute.DELETE(request("/api/connections/user", { kind: "database", id: "c1" }, "DELETE"));
    expect(await res.json()).toEqual({ ok: true });
    await testRoute.POST(
      request("/api/connections/user/test", { kind: "database", connection: { ...PG, password: "" } }),
    );
    expect((probes[0].body as { connection: Record<string, unknown> }).connection).not.toHaveProperty("password");
  });

  test("refuses no session and a missing id", async () => {
    expect((await userRoute.DELETE(request("/api/connections/user", { kind: "database" }, "DELETE"))).status).toBe(400);
    session = null;
    expect(
      (await userRoute.DELETE(request("/api/connections/user", { kind: "database", id: "c1" }, "DELETE"))).status,
    ).toBe(401);
  });
});

describe("POST /api/connections/user/test", () => {
  test("hands the family's test route the edit with the stored secret filled in, and answers its verdict", async () => {
    await userRoute.POST(request("/api/connections/user", { kind: "database", connection: PG }));
    const res = await testRoute.POST(
      request("/api/connections/user/test", { kind: "database", connection: { ...PG, name: "draft", password: "" } }),
    );
    expect(await res.json()).toEqual({ success: true, latency: 3 });
    expect(probes[0]).toMatchObject({ family: "database", body: { connection: { name: "draft", password: "pw-1" } } });

    await userRoute.POST(
      request("/api/connections/user", {
        kind: "resource",
        connection: { id: "r1", name: "b", type: "s3", accessKeyId: "A", secretAccessKey: "S-1" },
      }),
    );
    const resource = await testRoute.POST(
      request("/api/connections/user/test", {
        kind: "resource",
        connection: { id: "r1", name: "b", type: "s3", accessKeyId: "A" },
      }),
    );
    expect(await resource.json()).toEqual({ success: true, latencyMs: 4 });
    expect(probes[1]).toMatchObject({ family: "resource", body: { connection: { secretAccessKey: "S-1" } } });
  });

  test("refuses no session, a bad body and a bad kind", async () => {
    expect((await testRoute.POST(request("/api/connections/user/test", "nope"))).status).toBe(400);
    expect((await testRoute.POST(request("/api/connections/user/test", { kind: "x", connection: PG }))).status).toBe(
      400,
    );
    session = null;
    expect(
      (await testRoute.POST(request("/api/connections/user/test", { kind: "database", connection: PG }))).status,
    ).toBe(401);
    expect(probes).toHaveLength(0);
  });
});

describe("POST /api/connections/user/migrate", () => {
  test("moves both families and answers them without secrets", async () => {
    const res = await migrateRoute.POST(
      request("/api/connections/user/migrate", {
        connections: [PG],
        resourceConnections: [{ id: "r1", name: "b", type: "s3", secretAccessKey: "S-1" }],
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("pw-1");
    expect(text).not.toContain("S-1");
    const body = JSON.parse(text);
    expect(body.migrated).toBe(2);
    expect(body.connections[0].savedSecrets).toEqual(["password"]);
    expect(body.resourceConnections[0].savedSecrets).toEqual(["secretAccessKey"]);
    const empty = await migrateRoute.POST(request("/api/connections/user/migrate", {}));
    expect((await empty.json()).migrated).toBe(0);
  });

  test("refuses no session and a bad body", async () => {
    expect((await migrateRoute.POST(request("/api/connections/user/migrate", "nope"))).status).toBe(400);
    session = null;
    expect((await migrateRoute.POST(request("/api/connections/user/migrate", {}))).status).toBe(401);
  });
});
