import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";

export const dynamic = "force-dynamic";

/** One object's metadata. A read: audited nowhere, like every object read. */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/meta", async (connection, body) => {
    const { bucket, name } = requireBlobAddress(body);
    const blob = await resolveBlobOperations(connection, "blob.read");
    return NextResponse.json(await blob.readBlobMeta(bucket, name));
  });
}
