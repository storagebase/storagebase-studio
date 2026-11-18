import { NextResponse } from "next/server";
import {
  auditedKafkaRead,
  handleKafkaRequest,
  isGroupId,
  requireNameBatch,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Total lag for a bounded batch of consumer groups; unreadable ones answer a reason. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/groups/lag", async (kafka, body, ctx) => {
    const groupIds = requireNameBatch(body, "groupIds", isGroupId);
    const lags = await auditedKafkaRead(
      ctx,
      req,
      "kafka.groups.lag",
      `${ctx.connection.type}:${ctx.connection.name}`,
      kafka,
      (provider) => provider.measureGroupLag(groupIds),
      (read) => ({
        itemsListed: Object.keys(read).length,
        unreadable: Object.values(read).filter((entry) => entry.lagError !== null).length,
      }),
    );
    return NextResponse.json({ lags });
  });
}
