import { NextResponse } from "next/server";
import { auditedKafkaRead, handleKafkaRequest } from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Brokers, controller and cluster id — a read, audited with the broker count only. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/cluster", async (kafka, _body, ctx) => {
    const overview = await auditedKafkaRead(
      ctx,
      req,
      "kafka.cluster.read",
      `${ctx.connection.type}:${ctx.connection.name}`,
      kafka,
      (provider) => provider.describeCluster(),
      (read) => ({ brokers: read.brokers.length }),
    );
    return NextResponse.json(overview);
  });
}
