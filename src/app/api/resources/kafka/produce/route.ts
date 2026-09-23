import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { auditedKafkaWrite, optionalPartition, optionalStringMap, requireTopicName } from "@/lib/api/resource-kafka";

export const dynamic = "force-dynamic";

/** Produce one record (value, optional key, headers, partition). Audited as `resource_operation`. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/kafka/produce", async (connection, body, context) => {
    const topic = requireTopicName(body);
    if (typeof body.value !== "string") {
      throw new ResourceRouteError('"value" must be a string', 400);
    }
    if (body.key !== undefined && typeof body.key !== "string") {
      throw new ResourceRouteError('"key" must be a string when present', 400);
    }
    const value = body.value;
    const key = body.key as string | undefined;
    const headers = optionalStringMap(body, "headers");
    const partition = optionalPartition(body);
    const result = await auditedKafkaWrite(
      connection,
      context,
      "kafka.produce",
      `topic/${topic}`,
      "kafka.produce",
      (kafka) =>
        kafka.produceMessage(topic, {
          value,
          ...(key === undefined ? {} : { key }),
          ...(headers === undefined ? {} : { headers }),
          ...(partition === undefined ? {} : { partition }),
        }),
      req,
    );
    return NextResponse.json(result);
  });
}
