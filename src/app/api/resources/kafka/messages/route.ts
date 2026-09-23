import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  optionalPartition,
  requireInteger,
  requireSeek,
  requireTopicName,
  resolveKafkaOperations,
} from "@/lib/api/resource-kafka";
import { KAFKA_READ_LIMIT } from "@/lib/resources/providers/messaging/kafka";

export const dynamic = "force-dynamic";

/**
 * Read a topic from a seek position, bounded by count, bytes and time (the
 * provider owns the last two). A read: audited nowhere, the browse precedent.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/messages", async (connection, body) => {
    const topic = requireTopicName(body);
    const seek = requireSeek(body);
    const limit = body.limit === undefined ? 50 : requireInteger(body, "limit", 1, KAFKA_READ_LIMIT);
    const partition = optionalPartition(body);
    const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
    return NextResponse.json(
      await kafka.readMessages(topic, { seek, limit, ...(partition === undefined ? {} : { partition }) }),
    );
  });
}
