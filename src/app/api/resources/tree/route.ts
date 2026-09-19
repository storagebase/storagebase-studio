import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { getOrCreateResourceProvider, removeResourceProvider } from "@/lib/resources/factory";

export const dynamic = "force-dynamic";

/**
 * One bounded level of a resource tree: the roots when `parent` is absent, the
 * children of that node id otherwise. The page's `truncated` flag is the
 * provider's honest sentence about its own bound, never a guess.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/tree", async (connection, body) => {
    const parentId = body.parent;
    if (parentId !== undefined && (typeof parentId !== "string" || parentId === "")) {
      throw new ResourceRouteError('"parent" must be a node id string, or absent for the root level', 400);
    }
    try {
      const provider = await getOrCreateResourceProvider(connection);
      return NextResponse.json(await provider.listNodes(parentId ?? null));
    } catch (error) {
      await removeResourceProvider(connection.id).catch(() => undefined);
      throw error;
    }
  });
}
