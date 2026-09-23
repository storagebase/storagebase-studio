import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedKafkaWrite, optionalStringMap, requireInteger, requireTopicName } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** Create a topic. Audited as `resource_operation` decision + outcome. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic/create", async (connection, body, context) => {
    const topic = requireTopicName(body);
    const partitions = requireInteger(body, "partitions", 1, 10_000);
    const replicationFactor = requireInteger(body, "replicationFactor", 1, 32);
    const configs = optionalStringMap(body, "configs");
    await auditedKafkaWrite(
      connection,
      context,
      "kafka.topic.create",
      `topic/${topic}`,
      "kafka.topic.write",
      (kafka) => kafka.createTopic({ name: topic, partitions, replicationFactor, ...(configs ? { configs } : {}) }),
      req,
    );
    return NextResponse.json({ created: true });
  });
}
