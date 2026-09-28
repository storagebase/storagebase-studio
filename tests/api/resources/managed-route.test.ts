import { describe, test, expect, beforeEach, mock } from "bun:test";
import { installAccessStore } from "../../helpers/access-store";
import { installAuthMock } from "../../helpers/auth-mock";

/**
 * GET /api/resources/managed (StorageBase fork): the caller's admin-managed resource connections,
 * without credentials. It requires a session; an unreadable store is a 500, never a silent list.
 */

const handle = installAccessStore();
let session: Record<string, unknown> | null = null;
installAuthMock({ getSession: () => session });

const { GET } = await import("@/app/api/resources/managed/route");
const store = await import("@/lib/access/store");

beforeEach(async () => {
  await handle.reset();
  session = null;
  await store.createGroup({ id: "ops", name: "Ops" }, "root");
  await store.createBinding({ appRoleValue: "Team.Ops.Read", groupId: "ops", permission: "read" }, "root");
  await store.createManagedConnection(
    {
      id: "events",
      kind: "resource",
      type: "kafka",
      name: "Events",
      groupIds: ["ops"],
      config: { endpoint: "broker:9092", connectionString: "sasl-secret" },
    },
    "root",
  );
});

describe("GET /api/resources/managed", () => {
  test("anonymous: 401 and nothing read", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  test("a member gets the row, and nothing of its address or credential", async () => {
    session = { role: "user", username: "alice", appRoles: ["Team.Ops.Read"] };
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      connections: [{ id: "managed:events", permission: "read", groupNames: ["Ops"] }],
    });
    expect(text).not.toContain("broker:9092");
    expect(text).not.toContain("sasl-secret");
  });

  test("an unreadable store is a 500", async () => {
    session = { role: "admin", username: "root" };
    handle.mode = "broken";
    expect((await GET()).status).toBe(500);
  });
});
