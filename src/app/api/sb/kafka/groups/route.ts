import { NextResponse } from "next/server";
import { auditedKafkaRead, handleKafkaRequest } from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** State and members of every consumer group; lag is measured by the rows on screen. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/groups", async (kafka, _body, ctx) => {
    const listing = await auditedKafkaRead(
      ctx,
      req,
      "kafka.groups.list",
      `${ctx.connection.type}:${ctx.connection.name}`,
      kafka,
      (provider) => provider.listConsumerGroups(),
      (read) => ({ itemsListed: read.groups.length }),
    );
    return NextResponse.json(listing);
  });
}
