import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { requireTopicName, resolveKafkaOperations } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** One topic: partitions with leader/replicas/ISR and offsets, plus its configs. A read: audited nowhere. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic", async (connection, body) => {
    const topic = requireTopicName(body);
    const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
    return NextResponse.json(await kafka.describeTopic(topic));
  });
}
