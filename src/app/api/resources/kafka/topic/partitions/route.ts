import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedKafkaWrite, requireInteger, requireTopicName } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** Raise a topic's partition count to `count` (the new total). Audited as `resource_operation`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic/partitions", async (connection, body, context) => {
    const topic = requireTopicName(body);
    const count = requireInteger(body, "count", 1, 10_000);
    await auditedKafkaWrite(
      connection,
      context,
      "kafka.topic.partitions",
      `topic/${topic}`,
      "kafka.topic.write",
      (kafka) => kafka.addPartitions(topic, count),
      req,
    );
    return NextResponse.json({ partitions: count });
  });
}
