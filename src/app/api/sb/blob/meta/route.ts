import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";
import { resolveBlobOperations, requireBlobAddress } from "@/storagebase/resources/providers/blob/blob-route";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import type { StoragebaseAuditCounts } from "@/storagebase/audit/types";

export const dynamic = "force-dynamic";

/** One object's metadata. Audited as `blob.meta` with the object's address and size. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/blob/meta", async (connection, body, ctx) => {
    const { bucket, name } = requireBlobAddress(body);
    const meta = await auditedResourceRead(
      ctx,
      req,
      "blob.meta",
      `${connection.type}:${bucket}/${name}`,
      async () => {
        const blob = await resolveBlobOperations(connection, "blob.read");
        return blob.readBlobMeta(bucket, name);
      },
      (read): StoragebaseAuditCounts => (read.sizeBytes === null ? {} : { bytes: read.sizeBytes }),
    );
    return NextResponse.json(meta);
  });
}
