import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  optionalStringMap,
  requireInteger,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Create a topic with explicit partitions, replication and optional configs. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topic/create", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    const partitions = requireInteger(body, "partitions", 1, 10_000);
    const replicationFactor = requireInteger(body, "replicationFactor", 1, 32);
    const configs = optionalStringMap(body, "configs");
    await auditedKafkaWrite(ctx, req, "kafka.topic.create", `topic/${topic}`, kafka, (provider) =>
      provider.createTopic({
        name: topic,
        partitions,
        replicationFactor,
        ...(configs === undefined ? {} : { configs }),
      }),
    );
    return NextResponse.json({ created: true });
  });
}
