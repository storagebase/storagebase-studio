import "../../../setup-dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockGlobalFetch, restoreGlobalFetch } from "../../../helpers/mock-fetch";
import {
  forgetServerHeldConnection,
  migrateBrowserConnections,
  readConnectionStorageMode,
  resetConnectionStorageModeForTests,
  saveServerHeldConnection,
  testServerHeldConnection,
  UserConnectionRequestError,
} from "@/lib/user-connections/client";

/**
 * Where the browser keeps a user's connections: `server` when the deployment
 * has server storage, `browser` otherwise — including when the config cannot
 * be read, because the answer decides where a secret is SENT and the browser
 * is where it already is.
 */

beforeEach(() => {
  resetConnectionStorageModeForTests();
});

afterEach(() => {
  resetConnectionStorageModeForTests();
  restoreGlobalFetch();
});

describe("readConnectionStorageMode", () => {
  test("server storage answers server", async () => {
    mockGlobalFetch({ "/api/storage/config": { json: { serverMode: true } } });
    await expect(readConnectionStorageMode()).resolves.toBe("server");
  });

  test("anything else answers browser", async () => {
    mockGlobalFetch({ "/api/storage/config": { json: { serverMode: false } } });
    await expect(readConnectionStorageMode()).resolves.toBe("browser");
  });

  test("a refused config answers browser", async () => {
    mockGlobalFetch({ "/api/storage/config": { status: 500, json: {} } });
    await expect(readConnectionStorageMode()).resolves.toBe("browser");
  });

  test("an unreachable config answers browser", async () => {
    mockGlobalFetch({
      "/api/storage/config": () => {
        throw new Error("network down");
      },
    });
    await expect(readConnectionStorageMode()).resolves.toBe("browser");
  });

  test("the answer is memoized until reset", async () => {
    const fetchMock = mockGlobalFetch({ "/api/storage/config": { json: { serverMode: true } } });
    await expect(readConnectionStorageMode()).resolves.toBe("server");
    await expect(readConnectionStorageMode()).resolves.toBe("server");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetConnectionStorageModeForTests();
    await expect(readConnectionStorageMode()).resolves.toBe("server");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("saveServerHeldConnection", () => {
  test("answers the copy the browser may keep", async () => {
    const seen: Record<string, unknown>[] = [];
    mockGlobalFetch({
      "/api/connections/user": async (req) => {
        seen.push((await req.json()) as Record<string, unknown>);
        return { json: { connection: { id: "c1", savedSecrets: ["password"] } } };
      },
    });
    const connection: { id: string; type?: string; host?: string; savedSecrets?: string[] } = {
      id: "c1",
      type: "postgres",
      host: "db",
    };
    await expect(saveServerHeldConnection("database", connection, ["password"])).resolves.toEqual({
      id: "c1",
      savedSecrets: ["password"],
    });
    expect(seen).toEqual([{ kind: "database", connection, clear: ["password"] }]);
  });

  test("a refusal arrives in the server's own words", async () => {
    mockGlobalFetch({ "/api/connections/user": { status: 403, json: { error: "read-only grant" } } });
    const error = await saveServerHeldConnection("database", { id: "c1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserConnectionRequestError);
    expect((error as Error).message).toBe("read-only grant");
  });
});

describe("testServerHeldConnection", () => {
  test("answers whatever the server's probe answers", async () => {
    mockGlobalFetch({ "/api/connections/user/test": { json: { ok: true } } });
    await expect(testServerHeldConnection("resource", { id: "r1" })).resolves.toEqual({ ok: true });
  });
});

describe("forgetServerHeldConnection", () => {
  test("a connection the server holds nothing for sends nothing", () => {
    const fetchMock = mockGlobalFetch({ "/api/connections/user": { json: {} } });
    forgetServerHeldConnection("database", { id: "c1" });
    forgetServerHeldConnection("database", { id: "c1", savedSecrets: "password" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a held connection is forgotten by id, and a refused forget never throws", async () => {
    const seen: Array<{ method: string; body: unknown }> = [];
    mockGlobalFetch({
      "/api/connections/user": async (req) => {
        seen.push({ method: req.method, body: await req.json() });
        return { status: 500, json: { error: "gone" } };
      },
    });
    forgetServerHeldConnection("database", { id: "c1", savedSecrets: ["password"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([{ method: "DELETE", body: { kind: "database", id: "c1" } }]);
  });
});

describe("migrateBrowserConnections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("a browser with nothing left to move sends nothing", async () => {
    const fetchMock = mockGlobalFetch({ "/api/connections/user/migrate": { json: {} } });
    await expect(migrateBrowserConnections()).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("held rows stay, the rest move once, and the server's answer replaces the browser's", async () => {
    const held = { id: "held", savedSecrets: ["password"] };
    const plain = { id: "c1", type: "postgres", password: "pw-1" };
    localStorage.setItem("libredb_connections", JSON.stringify([held, plain]));
    localStorage.setItem("libredb_resource_connections", JSON.stringify([]));
    const seen: unknown[] = [];
    mockGlobalFetch({
      "/api/connections/user/migrate": async (req) => {
        seen.push(await req.json());
        return { json: { migrated: 1, connections: [held], resourceConnections: [] } };
      },
    });
    await expect(migrateBrowserConnections()).resolves.toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ connections: [plain], resourceConnections: [] });
    expect(JSON.parse(localStorage.getItem("libredb_connections") as string)).toEqual([held]);
  });

  test("a refused move throws in the server's words", async () => {
    localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1" }]));
    mockGlobalFetch({ "/api/connections/user/migrate": { status: 409, json: { error: "no store" } } });
    await expect(migrateBrowserConnections()).rejects.toThrow("no store");
  });
});
