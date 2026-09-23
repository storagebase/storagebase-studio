import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedKafkaWrite, requireGroupId } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** Delete a consumer group (Empty only, the provider enforces it). Audited as `resource_operation`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/group/delete", async (connection, body, context) => {
    const groupId = requireGroupId(body);
    await auditedKafkaWrite(
      connection,
      context,
      "kafka.group.delete",
      `group/${groupId}`,
      "kafka.group.write",
      (kafka) => kafka.deleteConsumerGroup(groupId),
      req,
    );
    return NextResponse.json({ deleted: true });
  });
}
