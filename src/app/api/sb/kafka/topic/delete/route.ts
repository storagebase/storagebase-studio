import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  requireConfirmName,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Delete a topic. The body must repeat its name; the route checks it again. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topic/delete", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    requireConfirmName(body, topic);
    await auditedKafkaWrite(ctx, req, "kafka.topic.delete", `topic/${topic}`, kafka, (provider) =>
      provider.deleteTopic(topic),
    );
    return NextResponse.json({ deleted: true });
  });
}
