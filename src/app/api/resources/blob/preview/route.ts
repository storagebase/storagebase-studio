import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";
import { auditedResourceRead } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/** A bounded preview for the viewer. Audited as `blob.preview`: the object's address, never its content. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/preview", async (connection, body, ctx) => {
    const { bucket, name } = requireBlobAddress(body);
    const byteLimit = body.byteLimit ?? 65536;
    if (typeof byteLimit !== "number" || !Number.isInteger(byteLimit) || byteLimit < 1) {
      throw new ResourceRouteError('"byteLimit" must be a positive integer when present', 400);
    }
    const preview = await auditedResourceRead(
      ctx,
      req,
      "blob.preview",
      `${connection.type}:${bucket}/${name}`,
      async () => {
        const blob = await resolveBlobOperations(connection, "blob.read");
        return blob.previewBlob(bucket, name, byteLimit);
      },
      (read) => ({ byteLimit, truncated: read.truncated }),
    );
    return NextResponse.json(preview);
  });
}
