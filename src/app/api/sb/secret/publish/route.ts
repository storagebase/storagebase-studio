import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";
import {
  optionalAttributes,
  requireDestination,
  requireMessageBody,
  resolveSecretOperations,
  secretValueOf,
} from "@/storagebase/resources/providers/vaults/resource-secret";

export const dynamic = "force-dynamic";

/**
 * Publish one secret by path (`destination`), with the body as its value and
 * optional string `attributes` as extra fields (ported from the old fork's
 * /api/resources/message/publish). Audited as `resource_operation` with the
 * decision and outcome joined by one correlation id; the value never enters
 * the event.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/secret/publish", async (connection, body, context) => {
    const destination = requireDestination(body);
    const messageBody = requireMessageBody(body);
    const attributes = optionalAttributes(body);
    const user = context.session.username ?? context.session.role;
    const target = `${connection.type}:${destination}`;
    const correlationId = beginResourceWrite(user, "message.publish", target, req, context.connection);
    try {
      const secrets = await resolveSecretOperations(connection, "secret.write");
      await secrets.writeSecret(destination, secretValueOf(messageBody, attributes));
      endResourceWrite(user, "message.publish", target, correlationId, null, req, context.connection);
      return NextResponse.json({ published: true });
    } catch (error) {
      endResourceWrite(user, "message.publish", target, correlationId, error, req, context.connection);
      throw error;
    }
  });
}
