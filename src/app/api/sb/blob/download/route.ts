import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { resolveBlobOperations, requireBlobAddress } from "@/storagebase/resources/providers/blob/blob-route";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import type { StoragebaseAuditCounts } from "@/storagebase/audit/types";

export const dynamic = "force-dynamic";

/**
 * One object's bytes as the response body. Streams end to end — the route never
 * buffers the object. Audited as `blob.download` when the download starts, with
 * the object's address and its declared size; the bytes are never read here.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/blob/download", async (connection, body, ctx) => {
    const { bucket, name } = requireBlobAddress(body);
    const download = await auditedResourceRead(
      ctx,
      req,
      "blob.download",
      `${connection.type}:${bucket}/${name}`,
      async () => {
        const blob = await resolveBlobOperations(connection, "blob.download");
        return blob.downloadBlob(bucket, name);
      },
      (started): StoragebaseAuditCounts => (started.sizeBytes === null ? {} : { bytes: started.sizeBytes }),
    );
    return new NextResponse(download.body as BodyInit, {
      headers: {
        ...(download.contentType ? { "Content-Type": download.contentType } : {}),
        ...(download.sizeBytes === null ? {} : { "Content-Length": String(download.sizeBytes) }),
      },
    });
  });
}
