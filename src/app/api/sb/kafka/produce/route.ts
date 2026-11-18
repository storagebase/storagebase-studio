import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  optionalPartition,
  optionalStringMap,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";
import { ResourceRouteError } from "@/storagebase/resources/errors";

export const dynamic = "force-dynamic";

/** Produce one record (value, optional key, headers, partition). */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/produce", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    if (typeof body.value !== "string") throw new ResourceRouteError('"value" must be a string');
    if (body.key !== undefined && typeof body.key !== "string") {
      throw new ResourceRouteError('"key" must be a string when present');
    }
    const value = body.value;
    const key = body.key as string | undefined;
    const headers = optionalStringMap(body, "headers");
    const partition = optionalPartition(body);
    const result = await auditedKafkaWrite(ctx, req, "kafka.produce", `topic/${topic}`, kafka, (provider) =>
      provider.produceMessage(topic, {
        value,
        ...(key === undefined ? {} : { key }),
        ...(headers === undefined ? {} : { headers }),
        ...(partition === undefined ? {} : { partition }),
      }),
    );
    return NextResponse.json(result);
  });
}
