import { NextResponse } from "next/server";
import {
  auditedKafkaRead,
  handleKafkaRequest,
  requireGroupId,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** One consumer group: members and per-partition committed / end offsets and lag. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/group", async (kafka, body, ctx) => {
    const groupId = requireGroupId(body);
    const detail = await auditedKafkaRead(
      ctx,
      req,
      "kafka.group.read",
      `${ctx.connection.type}:${groupId}`,
      kafka,
      (provider) => provider.describeConsumerGroup(groupId),
      (read) => ({ members: read.members.length, partitions: read.offsets.length }),
    );
    return NextResponse.json(detail);
  });
}
