import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";

export const dynamic = "force-dynamic";

/** A bounded preview for the viewer. A read: audited nowhere. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/preview", async (connection, body) => {
    const { bucket, name } = requireBlobAddress(body);
    const byteLimit = body.byteLimit ?? 65536;
    if (typeof byteLimit !== "number" || !Number.isInteger(byteLimit) || byteLimit < 1) {
      throw new ResourceRouteError('"byteLimit" must be a positive integer when present', 400);
    }
    const blob = await resolveBlobOperations(connection, "blob.read");
    return NextResponse.json(await blob.previewBlob(bucket, name, byteLimit));
  });
}
