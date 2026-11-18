import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  requireInteger,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Raise a topic's partition count to `count` (the new total, never a delta). */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topic/partitions", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    const count = requireInteger(body, "count", 1, 10_000);
    await auditedKafkaWrite(ctx, req, "kafka.topic.partitions", `topic/${topic}`, kafka, (provider) =>
      provider.addPartitions(topic, count),
    );
    return NextResponse.json({ partitions: count });
  });
}
