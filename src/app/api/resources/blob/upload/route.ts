import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { resolveBlobOperations, requireBlobAddress } from "@/lib/api/resource-blob";
import { beginResourceWrite, endResourceWrite } from "@/lib/api/resource-audit";

export const dynamic = "force-dynamic";

/**
 * The largest single upload this route accepts, in decoded bytes. JSON carries
 * the body as base64 (≈4/3 overhead on the wire), so unbounded uploads would
 * let one request hold the server's memory hostage; larger objects go through
 * the provider SDKs directly, not this route.
 */
export const BLOB_UPLOAD_LIMIT = 10 * 1024 * 1024;

/**
 * Padded base64: alphabet characters, at most two trailing `=`, whole 4-character
 * groups (the length check). A single character class keeps the match linear —
 * a grouped pattern gives up on the multi-megabyte bodies this route accepts.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isPaddedBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Write one object. Audited as `resource_operation` with the decision and the
 * outcome joined by one correlation id; the confirm dialog lives client-side
 * (the viewer), the trail lives here.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/blob/upload", async (connection, body, { session }) => {
    const { bucket, name } = requireBlobAddress(body);
    if (typeof body.contentBase64 !== "string" || body.contentBase64 === "") {
      throw new ResourceRouteError('"contentBase64" must be a non-empty string', 400);
    }
    // Buffer.from(…, "base64") never throws — it skips what it cannot decode —
    // so the shape is checked first, or a typo would upload corrupted bytes.
    if (!isPaddedBase64(body.contentBase64)) {
      throw new ResourceRouteError('"contentBase64" is not valid base64', 400);
    }
    const bytes: Uint8Array = Buffer.from(body.contentBase64, "base64");
    if (bytes.length > BLOB_UPLOAD_LIMIT) {
      throw new ResourceRouteError(
        `Upload is ${bytes.length} bytes; this route accepts at most ${BLOB_UPLOAD_LIMIT}`,
        413,
      );
    }

    const user = session.username ?? session.role;
    const target = `${connection.type}:${bucket}/${name}`;
    const correlationId = beginResourceWrite(user, "blob.upload", target, req, connection);
    try {
      const blob = await resolveBlobOperations(connection, "blob.upload");
      const meta = await blob.uploadBlob(
        bucket,
        name,
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
      endResourceWrite(user, "blob.upload", target, correlationId, null, req, connection);
      return NextResponse.json(meta);
    } catch (error) {
      endResourceWrite(user, "blob.upload", target, correlationId, error, req, connection);
      throw error;
    }
  });
}
