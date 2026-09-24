import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { requireGroupId, resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * One consumer group: members and per-partition committed offset / end offset / lag.
 * Audited as `kafka.group.read` with the group id.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/group", async (connection, body, ctx) => {
    const groupId = requireGroupId(body);
    const detail = await auditedResourceRead(
      ctx,
      req,
      "kafka.group.read",
      `${connection.type}:${groupId}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.describeConsumerGroup(groupId);
      },
      (read) => ({ members: read.members.length, partitions: read.offsets.length }),
    );
    return NextResponse.json(detail);
  });
}
