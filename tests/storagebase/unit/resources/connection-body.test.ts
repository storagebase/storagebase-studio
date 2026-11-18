import { describe, test, expect } from "bun:test";
import { resourceConnectionBody } from "@/storagebase/resources/connection-body";
import type { ResourceConnection, SeededResourceConnection } from "@/storagebase/resources/types";

const owned: ResourceConnection = {
  id: "res_1",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "broker-a:9092",
};

describe("resourceConnectionBody", () => {
  test("names a connection by carrying it inline, for spreading into any route body", () => {
    expect(resourceConnectionBody(owned)).toEqual({ connection: owned });
    expect({ ...resourceConnectionBody(owned), parent: "a" }).toEqual({ connection: owned, parent: "a" });
  });

  test("a seeded connection is named by id only, so nothing about it but the id leaves the browser", () => {
    const seeded: SeededResourceConnection = { ...owned, id: "seed:prod-events", seeded: true, permission: "read" };
    expect(resourceConnectionBody(seeded)).toEqual({ connectionId: "seed:prod-events" });
    expect({ ...resourceConnectionBody(seeded), parent: "a" }).toEqual({
      connectionId: "seed:prod-events",
      parent: "a",
    });
  });
});
