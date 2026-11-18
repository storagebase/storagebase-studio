import { describe, expect, test } from "bun:test";
import {
  kafkaGrantedPermission,
  kafkaRoutePermission,
  KAFKA_ROUTE_PERMISSIONS,
  isGroupId,
  isTopicName,
  optionalPartition,
  optionalPartitionList,
  optionalStringMap,
  requireConfigChanges,
  requireGroupId,
  requireInteger,
  requireNameBatch,
  requireReset,
  requireSeek,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

describe("kafka route permissions", () => {
  test("the 15 routes are classified read/write/admin", () => {
    expect(Object.keys(KAFKA_ROUTE_PERMISSIONS)).toHaveLength(15);
    expect(kafkaRoutePermission("api/sb/kafka/topics")).toBe("read");
    expect(kafkaRoutePermission("api/sb/kafka/produce")).toBe("write");
    expect(kafkaRoutePermission("api/sb/kafka/group/delete")).toBe("admin");
    // A new, unclassified route fails closed at admin.
    expect(kafkaRoutePermission("api/sb/kafka/brand-new")).toBe("admin");
  });

  test("readOnly wins over role, admin role grants admin", () => {
    expect(kafkaGrantedPermission({ readOnly: true } as never, "admin")).toBe("read");
    expect(kafkaGrantedPermission({ readOnly: false } as never, "admin")).toBe("admin");
    expect(kafkaGrantedPermission({} as never, "user")).toBe("write");
  });
});

describe("kafka body grammar", () => {
  test("topic names follow Kafka's grammar", () => {
    expect(isTopicName("orders.v2-1")).toBe(true);
    expect(isTopicName(".")).toBe(false);
    expect(isTopicName("..")).toBe(false);
    expect(isTopicName("has space")).toBe(false);
    expect(() => requireTopicName({ topic: 1 })).toThrow('"topic"');
  });

  test("group ids are non-empty strings", () => {
    expect(isGroupId("g")).toBe(true);
    expect(isGroupId(" ")).toBe(false);
    expect(() => requireGroupId({ groupId: 1 })).toThrow('"groupId"');
  });

  test("batches are bounded and each name is valid", () => {
    expect(requireNameBatch({ names: ["a", "b"] }, "names", isTopicName)).toEqual(["a", "b"]);
    expect(() => requireNameBatch({ names: [] }, "names", isTopicName)).toThrow('"names"');
    expect(() => requireNameBatch({ names: ["a", " "] }, "names", isTopicName)).toThrow('"names" holds');
    expect(() => requireNameBatch({ names: Array(51).fill("a") }, "names", isTopicName)).toThrow('"names"');
  });

  test("integers are bounded", () => {
    expect(requireInteger({ count: 3 }, "count", 1, 5)).toBe(3);
    expect(() => requireInteger({ count: 0 }, "count", 1, 5)).toThrow('"count"');
    expect(() => requireInteger({ count: 1.5 }, "count", 1, 5)).toThrow('"count"');
  });

  test("optional fields pass through or refuse a wrong type", () => {
    expect(optionalPartition({})).toBeUndefined();
    expect(optionalPartition({ partition: null })).toBeUndefined();
    expect(optionalPartition({ partition: 2 })).toBe(2);
    expect(optionalPartitionList({})).toBeUndefined();
    expect(optionalPartitionList({ partitions: [0, 1] })).toEqual([0, 1]);
    expect(() => optionalPartitionList({ partitions: [] })).toThrow('"partitions"');
    expect(() => optionalPartitionList({ partitions: [-1] })).toThrow('"partitions"');
    expect(optionalStringMap({}, "headers")).toBeUndefined();
    expect(optionalStringMap({ headers: { h: "v" } }, "headers")).toEqual({ h: "v" });
    expect(() => optionalStringMap({ headers: null }, "headers")).toThrow('"headers"');
  });

  test("seek and reset accept the four modes", () => {
    expect(requireSeek({ seek: { mode: "earliest" } })).toEqual({ mode: "earliest" });
    expect(requireSeek({ seek: { mode: "latest" } })).toEqual({ mode: "latest" });
    expect(requireSeek({ seek: { mode: "offset", offset: "12" } })).toEqual({ mode: "offset", offset: "12" });
    expect(requireSeek({ seek: { mode: "timestamp", timestamp: 5 } })).toEqual({ mode: "timestamp", timestamp: 5 });
    expect(requireReset({ reset: { mode: "earliest" } })).toEqual({ mode: "earliest" });
  });

  test("config changes map names to values or null", () => {
    expect(requireConfigChanges({ changes: { a: "b", c: null } })).toEqual({ a: "b", c: null });
    expect(() => requireConfigChanges({ changes: [] })).toThrow('"changes"');
  });
});
