import type {
  ForkAdmin,
  ForkConsumer,
  ForkKafkaLibrary,
  ForkMessageStream,
  ForkProducer,
  KafkaWire,
  LibConfigDescription,
  LibGroup,
  LibGroupOffsets,
  LibMessage,
  LibMetadata,
  LibOffsetsTopic,
} from "@/storagebase/resources/providers/messaging/kafka-client";

/** Minimal metadata answer with one topic of two partitions. */
export function metadata(overrides: Partial<LibMetadata> = {}): LibMetadata {
  return {
    clusterId: "c-1",
    controllerId: 1,
    brokers: new Map([
      [1, { host: "b1", port: 9092, rack: "r1" }],
      [2, { host: "b2", port: 9092, rack: null }],
    ]),
    topics: new Map([
      [
        "orders",
        {
          id: "t-1",
          partitions: [
            { leader: 1, replicas: [1, 2], isr: [1, 2], offlineReplicas: [] },
            { leader: 2, replicas: [1, 2], isr: [1], offlineReplicas: [] },
          ],
        },
      ],
    ]),
    ...overrides,
  };
}

export interface FakeWireState {
  md: LibMetadata;
  topics: string[];
  high: bigint;
  low: bigint;
  configs: LibConfigDescription[];
  groups: Map<string, { id: string; state: string; protocolType: string }>;
  described: Map<string, LibGroup>;
  committed: LibGroupOffsets[];
  messages: LibMessage[];
  produced: Array<{ partition: number; baseOffset: bigint }>;
  sent: unknown[];
  created: unknown[];
  partitioned: unknown[];
  altered: unknown[];
  deletedTopics: unknown[];
  deletedGroups: unknown[];
  alterOffsets: unknown[];
  fail: string | null;
}

export function fakeWireState(overrides: Partial<FakeWireState> = {}): FakeWireState {
  return {
    md: metadata(),
    topics: ["orders", "__consumer_offsets"],
    high: BigInt(12),
    low: BigInt(2),
    configs: [
      {
        resourceName: "orders",
        configs: [
          {
            name: "cleanup.policy",
            value: "delete",
            readOnly: false,
            isSensitive: false,
            configSource: 1,
            isDefault: false,
          },
          { name: "password", value: null, readOnly: false, isSensitive: true, configSource: 1, isDefault: false },
          {
            name: "retention.ms",
            value: "60000",
            readOnly: false,
            isSensitive: false,
            configSource: 5,
            isDefault: true,
          },
        ],
      },
    ],
    groups: new Map([["g-1", { id: "g-1", state: "Empty", protocolType: "consumer" }]]),
    described: new Map([
      [
        "g-1",
        {
          state: "Empty",
          protocolType: "consumer",
          protocol: "range",
          members: new Map(),
        },
      ],
    ]),
    committed: [
      {
        groupId: "g-1",
        topics: [{ name: "orders", partitions: [{ partitionIndex: 0, committedOffset: BigInt(4) }] }],
      },
    ],
    messages: [
      {
        topic: "orders",
        partition: 0,
        offset: BigInt(4),
        timestamp: BigInt(1700000000000),
        key: new TextEncoder().encode("k"),
        value: new TextEncoder().encode('{"a":1}'),
        headers: new Map([[new TextEncoder().encode("h"), new TextEncoder().encode("v")]]),
      },
    ],
    produced: [{ partition: 0, baseOffset: BigInt(9) }],
    sent: [],
    created: [],
    partitioned: [],
    altered: [],
    deletedTopics: [],
    deletedGroups: [],
    alterOffsets: [],
    fail: null,
    ...overrides,
  };
}

/** Build a fake Admin/Producer/Consumer trio and the wire that hands them out. */
export function fakeWire(state: FakeWireState): {
  wire: KafkaWire;
  admin: ForkAdmin;
  producer: ForkProducer;
  consumer: ForkConsumer;
} {
  const fail = (what: string) => {
    if (state.fail === what) throw new Error(`fake failure: ${what}`);
  };
  const admin: ForkAdmin = {
    metadata: async () => {
      fail("metadata");
      return state.md;
    },
    listTopics: async () => {
      fail("listTopics");
      return [...state.topics];
    },
    listOffsets: async (options) => {
      fail("listOffsets");
      const first = (
        options as { topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; timestamp: bigint }> }> }
      ).topics[0];
      const topicAnswer = (name: string): LibOffsetsTopic => ({
        name,
        partitions: first.partitions.map((part) => ({
          partitionIndex: part.partitionIndex,
          offset: part.timestamp === BigInt(-2) || part.timestamp > BigInt(0) ? state.low : state.high,
        })),
      });
      return [topicAnswer(first.name)];
    },
    describeConfigs: async () => {
      fail("describeConfigs");
      return state.configs;
    },
    incrementalAlterConfigs: async (options) => {
      fail("incrementalAlterConfigs");
      state.altered.push(options);
    },
    createTopics: async (options) => {
      fail("createTopics");
      state.created.push(options);
      return [{ name: "orders" }];
    },
    createPartitions: async (options) => {
      fail("createPartitions");
      state.partitioned.push(options);
    },
    deleteTopics: async (options) => {
      fail("deleteTopics");
      state.deletedTopics.push(options);
    },
    listGroups: async () => {
      fail("listGroups");
      return state.groups;
    },
    describeGroups: async () => {
      fail("describeGroups");
      return state.described;
    },
    deleteGroups: async (options) => {
      fail("deleteGroups");
      state.deletedGroups.push(options);
    },
    listConsumerGroupOffsets: async () => {
      fail("listConsumerGroupOffsets");
      return state.committed;
    },
    alterConsumerGroupOffsets: async (options) => {
      fail("alterConsumerGroupOffsets");
      state.alterOffsets.push(options);
    },
    close: async () => {
      fail("close");
    },
  };
  const producer: ForkProducer = {
    send: async (options) => {
      fail("send");
      state.sent.push(options);
      return state.produced;
    },
    close: async () => undefined,
  };
  const stream = (): ForkMessageStream => {
    let index = 0;
    return {
      async *[Symbol.asyncIterator]() {
        while (index < state.messages.length) {
          const message = state.messages[index];
          index += 1;
          yield message;
        }
      },
      close: async () => undefined,
    };
  };
  const consumer: ForkConsumer = {
    consume: async () => {
      fail("consume");
      return stream();
    },
    close: async () => undefined,
  };
  return {
    wire: { admin, producer, newConsumer: () => consumer, close: async () => undefined },
    admin,
    producer,
    consumer,
  };
}

/** A fake library whose constructors return the objects from `fakeWire`. */
export function fakeLibrary(state: FakeWireState): ForkKafkaLibrary {
  const { admin, producer, consumer } = fakeWire(state);
  return {
    Admin: class {
      constructor(_options: object) {
        return admin;
      }
    } as unknown as ForkKafkaLibrary["Admin"],
    Producer: class {
      constructor(_options: object) {
        return producer;
      }
    } as unknown as ForkKafkaLibrary["Producer"],
    Consumer: class {
      constructor(_options: object) {
        return consumer;
      }
    } as unknown as ForkKafkaLibrary["Consumer"],
  };
}
