import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** One object's metadata. Audited as `blob.meta` with the object's address and size. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/meta", async (connection, body, ctx) => {
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
      (read) => ({ bytes: read.sizeBytes }),
    );
    return NextResponse.json(meta);
  });
}
