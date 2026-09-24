import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** Every topic, internal ones flagged (the UI filters them). Audited as `kafka.topics.list`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/topics", async (connection, _body, ctx) => {
    const listing = await auditedResourceRead(
      ctx,
      req,
      "kafka.topics.list",
      `${connection.type}:${connection.name}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.listTopicSummaries();
      },
      (read) => ({ itemsListed: read.topics.length, truncated: read.countsTruncated }),
    );
    return NextResponse.json(listing);
  });
}
