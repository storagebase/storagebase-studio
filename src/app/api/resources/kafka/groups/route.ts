import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveKafkaOperations } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** Consumer groups with state, members and total lag. A read: audited nowhere. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/groups", async (connection) => {
    const kafka = await resolveKafkaOperations(connection, "kafka.inspect");
    return NextResponse.json(await kafka.listConsumerGroups());
  });
}
