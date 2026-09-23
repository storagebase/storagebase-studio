import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  auditedKafkaWrite,
  optionalPartitionList,
  requireGroupId,
  requireReset,
  requireTopicName,
} from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/**
 * Reset a group's committed offsets on one topic. The provider refuses (409)
 * unless the group is Empty — live members own their offsets. Audited as
 * `resource_operation` decision + outcome.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/group/reset-offsets", async (connection, body, context) => {
    const groupId = requireGroupId(body);
    const topic = requireTopicName(body);
    const reset = requireReset(body);
    const partitions = optionalPartitionList(body);
    const offsets = await auditedKafkaWrite(
      connection,
      context,
      "kafka.group.reset-offsets",
      `group/${groupId}/${topic}`,
      "kafka.group.write",
      (kafka) =>
        kafka.resetConsumerGroupOffsets({ groupId, topic, reset, ...(partitions === undefined ? {} : { partitions }) }),
      req,
    );
    return NextResponse.json({ offsets });
  });
}
