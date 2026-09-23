import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedKafkaWrite, requireConfigChanges, requireTopicName } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/**
 * Alter topic-level config overrides (`null` resets one to the default). The
 * audit target names the topic, not the values: config values are the
 * caller's data, and the trail records who changed what, not to what.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic/config", async (connection, body, context) => {
    const topic = requireTopicName(body);
    const changes = requireConfigChanges(body);
    await auditedKafkaWrite(
      connection,
      context,
      "kafka.topic.config",
      `topic/${topic}`,
      "kafka.topic.write",
      (kafka) => kafka.alterTopicConfigs(topic, changes),
      req,
    );
    return NextResponse.json({ altered: Object.keys(changes) });
  });
}
