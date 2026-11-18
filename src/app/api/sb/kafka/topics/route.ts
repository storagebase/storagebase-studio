import { NextResponse } from "next/server";
import { auditedKafkaRead, handleKafkaRequest } from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Every topic from metadata alone; message counts are asked for by the rows on screen. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topics", async (kafka, _body, ctx) => {
    const listing = await auditedKafkaRead(
      ctx,
      req,
      "kafka.topics.list",
      `${ctx.connection.type}:${ctx.connection.name}`,
      kafka,
      (provider) => provider.listTopicSummaries(),
      (read) => ({ itemsListed: read.topics.length }),
    );
    return NextResponse.json(listing);
  });
}
