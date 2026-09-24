import { NextResponse } from "next/server";
import { handleResourceRequest } from "@/lib/api/resource-route";
import { auditedResourceRead } from "@/lib/api/resource-audit";
import { getOrCreateResourceProvider, removeResourceProvider } from "@/lib/resources/factory";

export const dynamic = "force-dynamic";

/**
 * Per-connection health for the sidebar pulse — the parallel of the POST half
 * of /api/db/health. Session-gated; never a public liveness probe (liveness
 * stays dependency-free by design, see src/lib/api/liveness.ts). Audited as
 * `resource.health`; the provider's own message is not recorded.
 */
export async function POST(req: Parameters<typeof handleResourceRequest>[0]) {
  return handleResourceRequest(req, "api/resources/health", async (connection, _body, ctx) => {
    const health = await auditedResourceRead(
      ctx,
      req,
      "resource.health",
      `${connection.type}:${connection.name}`,
      async () => {
        try {
          const provider = await getOrCreateResourceProvider(connection);
          return await provider.getHealth();
        } catch (error) {
          // The cached provider for this id may be dead; drop it so the next call
          // rebuilds rather than serving the same refusal forever.
          await removeResourceProvider(connection.id).catch(() => undefined);
          throw error;
        }
      },
      (read) => ({ healthy: read.status === "healthy", latencyMs: read.latencyMs }),
    );
    return NextResponse.json(health);
  });
}
