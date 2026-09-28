import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { isTopicName, requireNameBatch, resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Approximate message counts for a bounded batch of topics (`topics`, at most
 * 50) — what the topic list asks for the rows on screen. Best effort per
 * topic: an unreadable one answers `messageCount: null` with `countError`.
 * Audited as `kafka.topics.counts`.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topics/counts", async (connection, body, ctx) => {
    const topics = requireNameBatch(body, "topics", isTopicName);
    const counts = await auditedResourceRead(
      ctx,
      req,
      "kafka.topics.counts",
      `${connection.type}:${connection.name}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.countTopicMessages(topics);
      },
      (read) => ({
        itemsListed: Object.keys(read).length,
        unreadable: Object.values(read).filter((entry) => entry.countError !== null).length,
      }),
    );
    return NextResponse.json({ counts });
  });
}
