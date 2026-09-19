import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import {
  resolveMessagingOperations,
  requireDestination,
  requireMessageBody,
  optionalAttributes,
} from "@/lib/api/resource-messaging";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Publish one message. Audited as `resource_operation` with the decision and
 * the outcome joined by one correlation id.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/message/publish", async (connection, body, { session }) => {
    const destination = requireDestination(body);
    const messageBody = requireMessageBody(body);
    const attributes = optionalAttributes(body);
    const user = session.username ?? session.role;
    const target = `${connection.type}:${destination}`;
    const correlationId = beginResourceWrite(user, "message.publish", target);
    try {
      const messaging = await resolveMessagingOperations(connection, "message.publish");
      await messaging.publishMessage(destination, messageBody, attributes);
      endResourceWrite(user, "message.publish", target, correlationId, null);
      return NextResponse.json({ published: true });
    } catch (error) {
      endResourceWrite(user, "message.publish", target, correlationId, error);
      throw error;
    }
  });
}
