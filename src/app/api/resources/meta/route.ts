import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { createResourceProvider } from "@/lib/resources/factory";

export const dynamic = "force-dynamic";

/**
 * Resource provider capabilities and labels without opening a connection —
 * the parallel of /api/db/provider-meta, and for the same reason: metadata is
 * type-driven, so connecting would contend for sockets for nothing.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/meta", async (connection) => {
    const provider = await createResourceProvider(connection);
    return NextResponse.json({
      category: provider.getCapabilities().category,
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
    });
  });
}
