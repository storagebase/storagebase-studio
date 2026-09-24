import { NextResponse } from "next/server";
import { handleResourceRequest, ResourceRouteError } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { getOrCreateResourceProvider, removeResourceProvider } from "@/lib/resources/factory";
import { filterVaultTree } from "@/lib/api/resource-vault-workbench";

export const dynamic = "force-dynamic";

/**
 * One bounded level of a resource tree: the roots when `parent` is absent, the
 * children of that node id otherwise. The page's `truncated` flag is the
 * provider's honest sentence about its own bound, never a guess.
 *
 * Audited as `tree.list` with the parent's node id and how many nodes the level
 * listed — which is how a vault's secret NAMES, a bucket's object keys and a
 * broker's topics are listed, so the listing itself is on the trail. Never the
 * nodes' metadata.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/tree", async (connection, body, ctx) => {
    const parentId = body.parent;
    if (parentId !== undefined && (typeof parentId !== "string" || parentId === "")) {
      throw new ResourceRouteError('"parent" must be a node id string, or absent for the root level', 400);
    }
    const page = await auditedResourceRead(
      ctx,
      req,
      "tree.list",
      `${connection.type}:${parentId ?? "/"}`,
      async () => {
        try {
          const provider = await getOrCreateResourceProvider(connection);
          // Vault trees drop the leaves admin exclusion rules hide.
          return await filterVaultTree(connection, await provider.listNodes(parentId ?? null));
        } catch (error) {
          await removeResourceProvider(connection.id).catch(() => undefined);
          throw error;
        }
      },
      (listed) => ({ itemsListed: listed.nodes.length, truncated: listed.truncated }),
    );
    return NextResponse.json(page);
  });
}
