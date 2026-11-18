import { NextResponse } from "next/server";
import {
  auditedKafkaRead,
  handleKafkaRequest,
  isTopicName,
  requireNameBatch,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Approximate counts for a bounded batch of topics; unreadable ones answer a reason. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topics/counts", async (kafka, body, ctx) => {
    const topics = requireNameBatch(body, "topics", isTopicName);
    const counts = await auditedKafkaRead(
      ctx,
      req,
      "kafka.topics.counts",
      `${ctx.connection.type}:${ctx.connection.name}`,
      kafka,
      (provider) => provider.countTopicMessages(topics),
      (read) => ({
        itemsListed: Object.keys(read).length,
        unreadable: Object.values(read).filter((entry) => entry.countError !== null).length,
      }),
    );
    return NextResponse.json({ counts });
  });
}
