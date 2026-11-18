import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";
import { createMockRequest as rawRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realConnections from "@/storagebase/resources/connections";
import * as realSeed from "@/storagebase/resources/seed";
import type { ResourceConnection } from "@/storagebase/resources/types";
import { mockResolveConnection, responses, resetHarness, upstreamConnection } from "./harness";

const createMockRequest = (...args: Parameters<typeof rawRequest>): NextRequest =>
  rawRequest(...args) as unknown as NextRequest;

/**
 * The three ways `resolveKafkaConnection` reaches a connection. The route-level suite exercises the
 * happy path (an upstream kafka seed id); these doubles pin the other three shapes without a store,
 * a seed file or a socket. Bun's module mocks are process-wide, which is why this lives in its own
 * file: the main route suite keeps the real seed/connection resolvers.
 */
const seededConnection: ResourceConnection = {
  id: "seed:kafka-workbench",
  name: "Seeded Kafka",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const storedConnection: ResourceConnection = {
  id: "res_kafka1",
  name: "Stored Kafka",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockOpenSeeded = mock(async (): Promise<{ connection: ResourceConnection; permission: "read" } | null> => null);
mock.module("@/storagebase/resources/seed", () => ({
  ...realSeed,
  openSeededResourceConnection: mockOpenSeeded,
}));

const mockResolveStored = mock(async (): Promise<ResourceConnection> => storedConnection);
mock.module("@/storagebase/resources/connections", () => ({
  ...realConnections,
  resolveStoredResourceConnection: mockResolveStored,
}));

const { POST: cluster } = await import("@/app/api/sb/kafka/cluster/route");

async function post(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await cluster(createMockRequest("/api/sb/kafka/cluster", { method: "POST", body }));
  return { status: response.status, json: (await parseResponseJSON(response)) as Record<string, unknown> };
}

describe("kafka workbench connection resolution", () => {
  beforeEach(() => {
    clearRateLimitState();
    resetHarness();
    mockOpenSeeded.mockImplementation(async () => null);
    mockResolveStored.mockImplementation(async () => storedConnection);
    responses.describeCluster = { clusterId: "c", brokers: [], controllerId: 1 };
  });

  test("an inline connection with no connectionId resolves through the upstream resolver", async () => {
    const result = await post({ connection: { ...upstreamConnection } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(responses.describeCluster as Record<string, unknown>);
  });

  test("when the upstream resolver refuses the id, a matching fork seed connection is used", async () => {
    mockResolveConnection.mockImplementation(async () => {
      throw new Error("no such upstream connection");
    });
    mockOpenSeeded.mockImplementation(async () => ({ connection: seededConnection, permission: "read" }));

    const result = await post({ connectionId: seededConnection.id });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(responses.describeCluster as Record<string, unknown>);
    expect(mockOpenSeeded).toHaveBeenCalledWith(expect.anything(), seededConnection.id);
  });

  test("a res_ id falls through to the fork store when no seed matches", async () => {
    mockResolveConnection.mockImplementation(async () => {
      throw new Error("no such upstream connection");
    });

    const result = await post({ connectionId: storedConnection.id });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(responses.describeCluster as Record<string, unknown>);
    expect(mockResolveStored).toHaveBeenCalledWith(storedConnection.id);
  });

  test("an unrecognised id rethrows the upstream refusal rather than masking it", async () => {
    mockResolveConnection.mockImplementation(async () => {
      throw new Error("no such upstream connection");
    });

    const result = await post({ connectionId: "missing" });
    expect(result.status).not.toBe(200);
  });
});
