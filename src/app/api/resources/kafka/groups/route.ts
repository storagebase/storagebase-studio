import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** Consumer groups with state and members; lag is `groups/lag`. Audited as `kafka.groups.list`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/groups", async (connection, _body, ctx) => {
    const listing = await auditedResourceRead(
      ctx,
      req,
      "kafka.groups.list",
      `${connection.type}:${connection.name}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.listConsumerGroups();
      },
      (read) => ({ itemsListed: read.groups.length }),
    );
    return NextResponse.json(listing);
  });
}
