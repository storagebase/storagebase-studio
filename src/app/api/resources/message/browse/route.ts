import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveMessagingOperations, requireDestination } from "@/lib/api/resource-messaging";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** Peek at a destination's messages. Audited as `message.browse`: the destination and a count, never a body. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/message/browse", async (connection, body, ctx) => {
    const destination = requireDestination(body);
    const limit = body.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ResourceRouteError('"limit" must be an integer between 1 and 100 when present', 400);
    }
    const page = await auditedResourceRead(
      ctx,
      req,
      "message.browse",
      `${connection.type}:${destination}`,
      async () => {
        const messaging = await resolveMessagingOperations(connection, "message.browse");
        return messaging.browseMessages(destination, limit);
      },
      (read) => ({ messagesRead: read.messages.length, limit, truncated: read.truncated }),
    );
    return NextResponse.json(page);
  });
}
