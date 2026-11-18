import { NextResponse } from "next/server";
import { auditedResourceRead } from "@/storagebase/audit/resource";
import { createResourceProvider } from "@/storagebase/resources/factory";
import { handleResourceRequest } from "@/storagebase/resources/handle-request";

export const dynamic = "force-dynamic";

/**
 * Resource provider capabilities and labels without opening a connection —
 * the parallel of /api/db/provider-meta, and for the same reason: metadata is
 * type-driven, so connecting would contend for sockets for nothing. Audited as
 * `resource.meta`.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/sb/resources/meta", async (connection, _body, ctx) => {
    const meta = await auditedResourceRead(
      ctx,
      req,
      "resource.meta",
      `${connection.type}:${connection.name}`,
      async () => {
        const provider = await createResourceProvider(connection);
        return {
          category: provider.getCapabilities().category,
          capabilities: provider.getCapabilities(),
          labels: provider.getLabels(),
        };
      },
    );
    return NextResponse.json(meta);
  });
}
