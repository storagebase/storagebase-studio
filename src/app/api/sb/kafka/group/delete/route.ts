import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  requireGroupId,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Delete a consumer group (Empty only, the provider enforces it). */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/group/delete", async (kafka, body, ctx) => {
    const groupId = requireGroupId(body);
    await auditedKafkaWrite(ctx, req, "kafka.group.delete", `group/${groupId}`, kafka, (provider) =>
      provider.deleteConsumerGroup(groupId),
    );
    return NextResponse.json({ deleted: true });
  });
}
