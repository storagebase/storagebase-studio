import { NextResponse, type NextRequest } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/storagebase/resources/handle-request";
import { resolveBlobOperations, requireBlobUpload } from "@/storagebase/resources/providers/blob/blob-route";
import { beginResourceWrite, endResourceWrite } from "@/storagebase/audit/resource";

export const dynamic = "force-dynamic";

/**
 * The largest single upload this route accepts, in bytes. The multipart body
 * is buffered once by the form parser (Next hands the file part over as a
 * `File`), so an unbounded route would let one request hold the server's
 * memory hostage; the provider then re-streams it in bounded blocks
 * (`AZURE_BLOB_UPLOAD_BLOCK_SIZE`), never holding it a second time whole.
 * Larger objects go through the provider SDKs directly, not this route.
 */
export const BLOB_UPLOAD_LIMIT = 128 * 1024 * 1024;

/**
 * The one body mode the shared handler does not know: multipart/form-data.
 * The wrapper guards, resolves and maps nothing — those stay
 * `handleResourceRequest`'s, in its order. It only reinterprets what the
 * shared body reader parses AFTER the guard: `req.json()` reads the multipart
 * form's fields instead (file parts stay `File` values, and a stringified
 * inline `connection` field is parsed back to an object). Guard-before-parse
 * is the shared handler's property and this route keeps it: the form is
 * never opened for an unauthenticated caller, and the rate limiter still sees
 * the request before any parsing is done for it.
 */
function multipartJsonRequest(req: NextRequest): NextRequest {
  return new Proxy(req, {
    get(target, property) {
      if (property === "json") return () => readMultipartFields(target);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function readMultipartFields(req: NextRequest): Promise<Record<string, unknown>> {
  const form = await req.formData();
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    // A form field is a string; an inline connection travels stringified. A
    // value that is not JSON stays the raw string, so the shared handler's
    // connection validation refuses it with its own sentence.
    body[key] = key === "connection" && typeof value === "string" ? parseJsonField(value) : value;
  }
  return body;
}

function parseJsonField(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Write one object, streamed: the request body is multipart/form-data (one
 * `file` part; the addressing fields travel as form fields), and the file's
 * own stream is what reaches `uploadStream` — no base64 layer, no whole-file
 * string, the legacy 10 MiB JSON cap gone with it.
 *
 * Audited as `resource_operation` with the decision and the outcome joined by
 * one correlation id; the confirm dialog lives client-side (the viewer), the
 * trail lives here.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(
    multipartJsonRequest(req),
    "api/sb/blob/upload",
    async (connection, body, { session }) => {
      const { bucket, name, file } = requireBlobUpload(body);
      if (file.size > BLOB_UPLOAD_LIMIT) {
        throw new ResourceRouteError(
          `Upload is ${file.size} bytes; this route accepts at most ${BLOB_UPLOAD_LIMIT}`,
          413,
        );
      }
      const user = session.username ?? session.role;
      const target = `${connection.type}:${bucket}/${name}`;
      const correlationId = beginResourceWrite(user, "blob.upload", target, req, connection);
      try {
        const blob = await resolveBlobOperations(connection, "blob.upload");
        const meta = await blob.uploadBlob(bucket, name, file.stream());
        endResourceWrite(user, "blob.upload", target, correlationId, null, req, connection);
        return NextResponse.json(meta);
      } catch (error) {
        endResourceWrite(user, "blob.upload", target, correlationId, error, req, connection);
        throw error;
      }
    },
  );
}
