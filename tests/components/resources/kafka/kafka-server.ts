import { mockGlobalFetch, type MockFetchResponse } from "../../../helpers/mock-fetch";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * A routed fake of /api/resources/kafka/* for the workbench component tests.
 * `mockGlobalFetch` matches by substring, which cannot tell `topic` from
 * `topic/create`; this answers on the exact route instead. Handlers default
 * to a small healthy cluster and can be overridden per test.
 */

export const connection: ResourceConnection = {
  id: "res-k",
  name: "events",
  type: "kafka",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "localhost:9092",
};

export type Handler = (body: Record<string, unknown>) => MockFetchResponse;

export const defaultHandlers: Record<string, Handler> = {
  cluster: () => ({
    json: {
      clusterId: "cluster-abc",
      controllerId: 1,
      brokers: [
        { nodeId: 1, host: "broker1", port: 9092, rack: null, isController: true },
        { nodeId: 2, host: "broker2", port: 9093, rack: "r2", isController: false },
      ],
    },
  }),
  topics: () => ({
    json: {
      topics: [
        {
          name: "__consumer_offsets",
          internal: true,
          partitions: 50,
          replicationFactor: 1,
          underReplicatedPartitions: 0,
          messageCount: 5,
          countError: null,
        },
        {
          name: "orders",
          internal: false,
          partitions: 2,
          replicationFactor: 2,
          underReplicatedPartitions: 1,
          messageCount: 3,
          countError: null,
        },
        {
          name: "payments",
          internal: false,
          partitions: 1,
          replicationFactor: 1,
          underReplicatedPartitions: 0,
          messageCount: null,
          countError: null,
        },
      ],
      countsTruncated: false,
    },
  }),
  topic: (body) => ({
    json: {
      name: body.topic,
      internal: String(body.topic).startsWith("__"),
      partitions: [
        {
          partition: 0,
          leader: 1,
          replicas: [1, 2],
          isr: [1, 2],
          offlineReplicas: [],
          earliestOffset: "0",
          latestOffset: "2",
        },
        {
          partition: 1,
          leader: 2,
          replicas: [1, 2],
          isr: [2],
          offlineReplicas: [],
          earliestOffset: "0",
          latestOffset: "1",
        },
      ],
      configs: [
        {
          name: "cleanup.policy",
          value: "delete",
          source: "DEFAULT_CONFIG",
          isDefault: true,
          readOnly: false,
          isSensitive: false,
        },
        {
          name: "retention.ms",
          value: "1000",
          source: "TOPIC_CONFIG",
          isDefault: false,
          readOnly: false,
          isSensitive: false,
        },
        { name: "secret.x", value: null, source: "TOPIC_CONFIG", isDefault: false, readOnly: false, isSensitive: true },
        {
          name: "message.format.version",
          value: "3.0",
          source: "STATIC_BROKER_CONFIG",
          isDefault: false,
          readOnly: true,
          isSensitive: false,
        },
      ],
      offsetsError: null,
    },
  }),
  messages: () => ({
    json: {
      messages: [
        {
          partition: 0,
          offset: "1",
          timestamp: "1700000000000",
          key: "order-1",
          value: '{"id":1,"total":9.5}',
          keyEncoding: "utf8",
          valueEncoding: "utf8",
          valueTruncated: false,
          valueBytes: 20,
          headers: { trace: "abc" },
        },
        {
          partition: 1,
          offset: "0",
          timestamp: "1700000000001",
          key: null,
          value: "//4A",
          keyEncoding: "utf8",
          valueEncoding: "base64",
          valueTruncated: true,
          valueBytes: 70000,
          headers: {},
        },
      ],
      truncated: true,
    },
  }),
  produce: () => ({ json: { partition: 1, offset: "42" } }),
  groups: () => ({
    json: {
      groups: [
        {
          groupId: "billing",
          state: "Stable",
          protocolType: "consumer",
          protocol: "range",
          members: 2,
          totalLag: 7,
          lagError: null,
          internal: false,
        },
        {
          groupId: "archiver",
          state: "Empty",
          protocolType: "consumer",
          protocol: "",
          members: 0,
          totalLag: null,
          lagError: null,
          internal: false,
        },
        {
          groupId: "storagebase-peek-x",
          state: "Empty",
          protocolType: "",
          protocol: "",
          members: 0,
          totalLag: null,
          lagError: null,
          internal: true,
        },
      ],
      lagTruncated: false,
    },
  }),
  group: (body) => ({
    json:
      body.groupId === "billing"
        ? {
            groupId: "billing",
            state: "Stable",
            protocolType: "consumer",
            protocol: "range",
            members: [
              {
                memberId: "m-1",
                clientId: "svc-1",
                clientHost: "/10.0.0.1",
                assignments: [{ topic: "orders", partitions: [0, 1] }],
              },
              { memberId: "m-2", clientId: "svc-2", clientHost: "/10.0.0.2", assignments: [] },
            ],
            offsets: [
              { topic: "orders", partition: 0, committedOffset: "1", endOffset: "2", lag: 1, endOffsetError: null },
              {
                topic: "orders",
                partition: 1,
                committedOffset: null,
                endOffset: null,
                lag: null,
                endOffsetError: "topic offsets unavailable",
              },
            ],
          }
        : {
            groupId: body.groupId,
            state: "Empty",
            protocolType: "consumer",
            protocol: "",
            members: [],
            offsets: [
              { topic: "orders", partition: 0, committedOffset: "0", endOffset: "2", lag: 2, endOffsetError: null },
            ],
          },
  }),
  "topic/create": () => ({ json: { created: true } }),
  "topic/delete": () => ({ json: { deleted: true } }),
  "topic/partitions": (body) => ({ json: { partitions: body.count } }),
  "topic/config": (body) => ({ json: { altered: Object.keys(body.changes as object) } }),
  "group/reset-offsets": () => ({ json: { offsets: [] } }),
  "group/delete": () => ({ json: { deleted: true } }),
};

export interface KafkaCall {
  route: string;
  body: Record<string, unknown>;
}

export function installKafkaServer(overrides: Record<string, Handler> = {}) {
  const calls: KafkaCall[] = [];
  const handlers = { ...defaultHandlers, ...overrides };
  mockGlobalFetch({
    "api/resources/kafka/": async (req) => {
      const route = new URL(req.url).pathname.replace(/^.*\/api\/resources\/kafka\//, "");
      const body = (await req.json()) as Record<string, unknown>;
      calls.push({ route, body });
      const handler = handlers[route];
      return handler ? handler(body) : { status: 404, json: { error: `no route ${route}` } };
    },
  });
  return {
    calls,
    last(route: string): Record<string, unknown> | undefined {
      return calls.filter((entry) => entry.route === route).at(-1)?.body;
    },
    count(route: string): number {
      return calls.filter((entry) => entry.route === route).length;
    },
  };
}

export const refuse =
  (status: number, error: string): Handler =>
  () => ({ status, json: { error } });
