import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveKafkaOperations } from "@/lib/api/resource-kafka";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** Brokers, controller and cluster id. Audited as `kafka.cluster.read`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/cluster", async (connection, _body, ctx) => {
    const cluster = await auditedResourceRead(
      ctx,
      req,
      "kafka.cluster.read",
      `${connection.type}:${connection.name}`,
      async () => {
        const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
        return kafka.describeCluster();
      },
      (read) => ({ brokers: read.brokers.length }),
    );
    return NextResponse.json(cluster);
  });
}
