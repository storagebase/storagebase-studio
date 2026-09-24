import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveMessagingOperations, requireDestination } from "@/lib/api/resource-messaging";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Purge a queue. Audited as `resource_operation` with the decision and the
 * outcome joined by one correlation id; the confirm lives client-side. Kafka
 * has no purge — its provider refuses with the honest sentence, recorded as
 * `resource_unsupported`.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/message/purge", async (connection, body, { session }) => {
    const destination = requireDestination(body);
    const user = session.username ?? session.role;
    const target = `${connection.type}:${destination}`;
    const correlationId = beginResourceWrite(user, "message.purge", target, req, connection);
    try {
      const messaging = await resolveMessagingOperations(connection, "message.purge");
      await messaging.purgeQueue(destination);
      endResourceWrite(user, "message.purge", target, correlationId, null, req, connection);
      return NextResponse.json({ purged: true });
    } catch (error) {
      endResourceWrite(user, "message.purge", target, correlationId, error, req, connection);
      throw error;
    }
  });
}
