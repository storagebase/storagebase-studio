import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveMessagingOperations, requireDestination } from "@/lib/api/resource-messaging";

export const dynamic = "force-dynamic";

/** Peek at a destination's messages. A read: audited nowhere. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/message/browse", async (connection, body) => {
    const destination = requireDestination(body);
    const limit = body.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ResourceRouteError('"limit" must be an integer between 1 and 100 when present', 400);
    }
    const messaging = await resolveMessagingOperations(connection, "message.browse");
    return NextResponse.json(await messaging.browseMessages(destination, limit));
  });
}
