import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";

export const dynamic = "force-dynamic";

/**
 * One object's bytes as the response body. A read: audited nowhere.
 * Streams end to end — the route never buffers the object.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/download", async (connection, body) => {
    const { bucket, name } = requireBlobAddress(body);
    const blob = await resolveBlobOperations(connection, "blob.download");
    const download = await blob.downloadBlob(bucket, name);
    return new NextResponse(download.body as BodyInit, {
      headers: {
        ...(download.contentType ? { "Content-Type": download.contentType } : {}),
        ...(download.sizeBytes === null ? {} : { "Content-Length": String(download.sizeBytes) }),
      },
    });
  });
}
