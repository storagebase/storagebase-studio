import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { isGroupId, requireNameBatch, resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Total lag for a bounded batch of consumer groups (`groupIds`, at most 50) —
 * what the group list asks for the rows on screen. Best effort per group: an
 * unreadable one answers `totalLag: null` with `lagError`. Audited as
 * `kafka.groups.lag`.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/groups/lag", async (connection, body, ctx) => {
    const groupIds = requireNameBatch(body, "groupIds", isGroupId);
    const lags = await auditedResourceRead(
      ctx,
      req,
      "kafka.groups.lag",
      `${connection.type}:${connection.name}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.measureGroupLag(groupIds);
      },
      (read) => ({
        itemsListed: Object.keys(read).length,
        unreadable: Object.values(read).filter((entry) => entry.lagError !== null).length,
      }),
    );
    return NextResponse.json({ lags });
  });
}
