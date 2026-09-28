import { describe, test, expect } from "bun:test";
import { resourceConnectionBody } from "@/lib/resources/connection-body";
import type { ManagedResourceConnection, ResourceConnection } from "@/lib/resources/types";

const owned: ResourceConnection = {
  id: "res-1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "localhost:9092",
};

describe("resourceConnectionBody", () => {
  test("names a connection by carrying it inline, for spreading into any route body", () => {
    expect(resourceConnectionBody(owned)).toEqual({ connection: owned });
    expect({ ...resourceConnectionBody(owned), topic: "orders" }).toEqual({ connection: owned, topic: "orders" });
  });

  test("a managed connection is named by id only, so nothing about it but the id leaves the browser", () => {
    const managed: ManagedResourceConnection = { ...owned, id: "managed:m-1", managed: true, permission: "read" };
    expect(resourceConnectionBody(managed)).toEqual({ connectionId: "managed:m-1" });
    expect({ ...resourceConnectionBody(managed), parent: "a" }).toEqual({ connectionId: "managed:m-1", parent: "a" });
  });
});
