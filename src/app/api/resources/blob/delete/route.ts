import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * Delete one object. Audited as `resource_operation` with the decision and
 * the outcome joined by one correlation id; the confirm dialog lives
 * client-side (the viewer), the trail lives here. A missing object is a 404,
 * not silent idempotency — the provider checks existence first.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/delete", async (connection, body, { session }) => {
    const { bucket, name } = requireBlobAddress(body);
    const user = session.username ?? session.role;
    const target = `${connection.type}:${bucket}/${name}`;
    const correlationId = beginResourceWrite(user, "blob.delete", target, req, connection);
    try {
      const blob = await resolveBlobOperations(connection, "blob.delete");
      await blob.deleteBlob(bucket, name);
      endResourceWrite(user, "blob.delete", target, correlationId, null, req, connection);
      return NextResponse.json({ deleted: true });
    } catch (error) {
      endResourceWrite(user, "blob.delete", target, correlationId, error, req, connection);
      throw error;
    }
  });
}
