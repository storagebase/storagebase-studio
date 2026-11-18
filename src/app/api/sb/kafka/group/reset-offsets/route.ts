import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  optionalPartitionList,
  requireGroupId,
  requireReset,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Reset a group's committed offsets on one topic; the provider refuses a live group. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/group/reset-offsets", async (kafka, body, ctx) => {
    const groupId = requireGroupId(body);
    const topic = requireTopicName(body);
    const reset = requireReset(body);
    const partitions = optionalPartitionList(body);
    const offsets = await auditedKafkaWrite(
      ctx,
      req,
      "kafka.group.reset-offsets",
      `group/${groupId}/${topic}`,
      kafka,
      (provider) =>
        provider.resetConsumerGroupOffsets({
          groupId,
          topic,
          reset,
          ...(partitions === undefined ? {} : { partitions }),
        }),
    );
    return NextResponse.json({ offsets });
  });
}
