import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { requireGroupId, resolveKafkaOperations } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** One consumer group: members and per-partition committed offset / end offset / lag. A read. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/group", async (connection, body) => {
    const groupId = requireGroupId(body);
    const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
    return NextResponse.json(await kafka.describeConsumerGroup(groupId));
  });
}
