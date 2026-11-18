import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/storagebase/resources/handle-request";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import {
  requireDestination,
  resolveSecretOperations,
  splitBrowseDestination,
} from "@/storagebase/resources/providers/vaults/resource-secret";

export const dynamic = "force-dynamic";

/**
 * Browse a KV mount's secrets as a bounded page of tree nodes — the generic
 * secret surface that backs a basic vault workbench (ported from the old
 * fork's /api/resources/message/browse). `destination` is a mount, optionally
 * followed by a folder path; the provider resolves it against the connection's
 * mount list. audited as `message.browse`: the destination and a count, never a
 * secret value.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/secret/browse", async (connection, body, context) => {
    const destination = requireDestination(body);
    const limit = body.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ResourceRouteError('"limit" must be an integer between 1 and 100 when present', 400);
    }
    const { mount, prefix } = splitBrowseDestination(destination);
    const page = await auditedResourceRead(
      context,
      req,
      "message.browse",
      `${connection.type}:${destination}`,
      async () => {
        const secrets = await resolveSecretOperations(connection, "secret.read");
        const listed = await secrets.listSecrets(mount, prefix);
        return {
          messages: listed.nodes.slice(0, limit),
          truncated: listed.truncated || listed.nodes.length > limit,
        };
      },
      (read) => ({ messagesRead: read.messages.length, limit, truncated: read.truncated }),
    );
    return NextResponse.json(page);
  });
}
