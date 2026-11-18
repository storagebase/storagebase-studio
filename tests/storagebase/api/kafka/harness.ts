import { mock } from "bun:test";
import * as realAuth from "@/lib/auth";
import * as realResolve from "@/lib/seed/resolve-connection";

/**
 * Route-test doubles for the Kafka workbench. The REAL request chain runs —
 * upstream `guardRoute`, `resolveConnection` is doubled with an upstream kafka
 * record, the fork's permission and SB_* error mapping, and the audit recorders
 * — while the provider is doubled so no SDK or socket is involved.
 */

export const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "admin",
    username: "admin",
  }),
);

export const mockReadSession = mock(async () => {
  const session = await mockGetSession();
  return session === null ? { kind: "anonymous" as const } : { kind: "authenticated" as const, session };
});

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mockReadSession,
}));

/** The upstream kafka connection the routes resolve server-side. */
export const upstreamConnection = {
  id: "seed:kafka-1",
  name: "cluster",
  type: "kafka",
  host: "b1",
  port: 9092,
  readOnly: false,
};

export const mockResolveConnection = mock(async () => upstreamConnection);
mock.module("@/lib/seed/resolve-connection", () => ({
  ...realResolve,
  resolveConnection: mockResolveConnection,
}));

export interface ProviderCall {
  readonly method: string;
  readonly args: readonly unknown[];
}
export const calls: ProviderCall[] = [];
export const responses: Record<string, unknown> = {};

const METHODS = [
  "describeCluster",
  "listTopicSummaries",
  "countTopicMessages",
  "describeTopic",
  "createTopic",
  "deleteTopic",
  "addPartitions",
  "alterTopicConfigs",
  "readMessages",
  "produceMessage",
  "listConsumerGroups",
  "measureGroupLag",
  "describeConsumerGroup",
  "resetConsumerGroupOffsets",
  "deleteConsumerGroup",
] as const;

// Routes call a shared proxy whose methods read the `responses` table at call time.
mock.module("@/storagebase/resources/providers/messaging/kafka", () => ({
  KAFKA_MEASURE_BATCH_LIMIT: 50,
  isKafkaOffsetReset: (value: unknown) => typeof value === "object" && value !== null && "mode" in value,
  KafkaProvider: class {
    constructor() {
      calls.push({ method: "constructor", args: [] });
      for (const method of METHODS) {
        Object.assign(this, {
          [method]: async (...args: unknown[]) => {
            calls.push({ method, args });
            if (method in responses) {
              const value = responses[method];
              return typeof value === "function" ? value(...args) : value;
            }
            return undefined;
          },
        });
      }
    }
  },
}));

export interface AuditRead {
  readonly action: string;
  readonly target: string;
  readonly counts?: Record<string, unknown>;
}
export interface AuditWrite {
  readonly kind: "decision" | "outcome";
  readonly action: string;
  readonly target: string;
  readonly error: unknown;
}
export const reads: AuditRead[] = [];
export const writes: AuditWrite[] = [];

mock.module("@/storagebase/audit/resource", () => ({
  beginResourceWrite: (_user: string, action: string, target: string) => {
    writes.push({ kind: "decision", action, target, error: null });
    return "correlation-1";
  },
  endResourceWrite: (_user: string, action: string, target: string, _id: string, error: unknown) => {
    writes.push({ kind: "outcome", action, target, error });
  },
  auditedResourceRead: async (
    _ctx: unknown,
    _req: unknown,
    action: string,
    target: string,
    run: () => Promise<unknown>,
    counts?: (result: unknown) => Record<string, unknown>,
  ) => {
    const result = await run();
    reads.push({ action, target, counts: counts?.(result) });
    return result;
  },
}));

export function resetHarness(): void {
  calls.length = 0;
  reads.length = 0;
  writes.length = 0;
  for (const key of Object.keys(responses)) delete responses[key];
  mockResolveConnection.mockImplementation(async () => upstreamConnection);
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
}
