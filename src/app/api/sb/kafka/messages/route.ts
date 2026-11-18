import { NextResponse } from "next/server";
import type { KafkaMessagesPage } from "@/storagebase/resources/operations";
import {
  auditedKafkaRead,
  handleKafkaRequest,
  optionalPartition,
  requireInteger,
  requireSeek,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** The seek position as the audit target writes it. */
function seekLabel(seek: { mode: string; offset?: string; timestamp?: number }): string {
  if (seek.mode === "offset") return `offset:${seek.offset}`;
  if (seek.mode === "timestamp") return `timestamp:${seek.timestamp}`;
  return seek.mode;
}

/** What a read returned, in numbers: count, bytes and offset range — never a value. */
function messageCounts(page: KafkaMessagesPage, limit: number): Record<string, number | boolean> {
  const offsets = page.messages.map((message) => Number(message.offset));
  return {
    messagesRead: page.messages.length,
    bytes: page.messages.reduce((sum, message) => sum + message.valueBytes, 0),
    limit,
    truncated: page.truncated,
    ...(offsets.length > 0 ? { firstOffset: Math.min(...offsets), lastOffset: Math.max(...offsets) } : {}),
  };
}

/** Read a topic from a seek position, bounded by count, bytes and time. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/messages", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    const seek = requireSeek(body);
    const limit = body.limit === undefined ? 50 : requireInteger(body, "limit", 1, 200);
    const partition = optionalPartition(body);
    const page = await auditedKafkaRead(
      ctx,
      req,
      "kafka.messages.read",
      `${ctx.connection.type}:${topic}[partition=${partition ?? "all"},seek=${seekLabel(seek)}]`,
      kafka,
      (provider) => provider.readMessages(topic, { seek, limit, ...(partition === undefined ? {} : { partition }) }),
      (read) => messageCounts(read, limit),
    );
    return NextResponse.json(page);
  });
}
