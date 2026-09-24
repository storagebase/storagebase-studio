import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { requireTopicName, resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * One topic: partitions with leader/replicas/ISR and offsets, plus its configs.
 * Audited as `kafka.topic.read` with the topic name; config values are never recorded.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic", async (connection, body, ctx) => {
    const topic = requireTopicName(body);
    const detail = await auditedResourceRead(
      ctx,
      req,
      "kafka.topic.read",
      `${connection.type}:${topic}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.describeTopic(topic);
      },
      (read) => ({ partitions: read.partitions.length, configs: read.configs.length }),
    );
    return NextResponse.json(detail);
  });
}
