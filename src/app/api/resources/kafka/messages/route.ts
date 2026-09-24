import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  optionalPartition,
  requireInteger,
  requireSeek,
  requireTopicName,
  resolveKafkaOperations,
} from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { KAFKA_READ_LIMIT } from "@/lib/resources/providers/messaging/kafka";
import type { KafkaMessagesPage, KafkaSeek } from "@/lib/resources/operations";

export const dynamic = "force-dynamic";

/** The seek position as the audit target writes it: `earliest`, `offset:42`, `timestamp:1700000000000`. */
function seekLabel(seek: KafkaSeek): string {
  if (seek.mode === "offset") return `offset:${seek.offset}`;
  if (seek.mode === "timestamp") return `timestamp:${seek.timestamp}`;
  return seek.mode;
}

/** What a read returned, in numbers: count, bytes and the offset range, never a key, value or header. */
function messageCounts(page: KafkaMessagesPage, limit: number): Record<string, unknown> {
  const offsets = page.messages.map((message) => Number(message.offset));
  return {
    messagesRead: page.messages.length,
    bytes: page.messages.reduce((sum, message) => sum + message.valueBytes, 0),
    limit,
    truncated: page.truncated,
    ...(offsets.length > 0 ? { firstOffset: Math.min(...offsets), lastOffset: Math.max(...offsets) } : {}),
  };
}

/**
 * Read a topic from a seek position, bounded by count, bytes and time (the
 * provider owns the last two). Audited as `kafka.messages.read` with the topic,
 * partition and seek position, and the count, bytes and offset range read —
 * never a message key, value or header.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/messages", async (connection, body, ctx) => {
    const topic = requireTopicName(body);
    const seek = requireSeek(body);
    const limit = body.limit === undefined ? 50 : requireInteger(body, "limit", 1, KAFKA_READ_LIMIT);
    const partition = optionalPartition(body);
    const page = await auditedResourceRead(
      ctx,
      req,
      "kafka.messages.read",
      `${connection.type}:${topic}[partition=${partition ?? "all"},seek=${seekLabel(seek)}]`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.readMessages(topic, { seek, limit, ...(partition === undefined ? {} : { partition }) });
      },
      (read) => messageCounts(read, limit),
    );
    return NextResponse.json(page);
  });
}
