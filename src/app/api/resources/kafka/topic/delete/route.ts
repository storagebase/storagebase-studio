import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { auditedKafkaWrite, requireTopicName } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/**
 * Delete a topic. The body must repeat the name as `confirm` — the typed
 * confirmation the UI asks for, enforced here too so a replayed or scripted
 * request cannot skip it. Audited as `resource_operation` decision + outcome.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topic/delete", async (connection, body, context) => {
    const topic = requireTopicName(body);
    if (body.confirm !== topic) {
      throw new ResourceRouteError('"confirm" must repeat the topic name exactly', 400);
    }
    await auditedKafkaWrite(
      connection,
      context,
      "kafka.topic.delete",
      `topic/${topic}`,
      "kafka.topic.write",
      (kafka) => kafka.deleteTopic(topic),
      req,
    );
    return NextResponse.json({ deleted: true });
  });
}
