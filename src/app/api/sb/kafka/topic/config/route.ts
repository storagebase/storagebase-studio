import { NextResponse } from "next/server";
import {
  auditedKafkaWrite,
  handleKafkaRequest,
  requireConfigChanges,
  requireTopicName,
} from "@/storagebase/resources/providers/messaging/kafka-route";

export const dynamic = "force-dynamic";

/** Alter topic-level config overrides; `null` resets one to the broker default. */
export async function POST(req: Parameters<typeof handleKafkaRequest>[0]) {
  return handleKafkaRequest(req, "api/sb/kafka/topic/config", async (kafka, body, ctx) => {
    const topic = requireTopicName(body);
    const changes = requireConfigChanges(body);
    await auditedKafkaWrite(ctx, req, "kafka.topic.config", `topic/${topic}`, kafka, (provider) =>
      provider.alterTopicConfigs(topic, changes),
    );
    return NextResponse.json({ altered: Object.keys(changes) });
  });
}
