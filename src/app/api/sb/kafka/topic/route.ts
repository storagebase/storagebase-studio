import { NextResponse } from "next/server";
import {
  auditedKafkaRead,
  handleKafkaRequest,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** One topic: partitions and offsets, plus its configs (values never audited). */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topic", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    const detail = await auditedKafkaRead(
      ctx,
      req,
      "kafka.topic.read",
      `${ctx.connection.type}:${topic}`,
      kafka,
      (provider) => provider.describeTopic(topic),
      (read) => ({ partitions: read.partitions.length, configs: read.configs.length }),
    );
    return NextResponse.json(detail);
  });
}
