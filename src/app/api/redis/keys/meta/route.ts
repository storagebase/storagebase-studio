import type { NextRequest } from "next/server";
import { handleRedisKeysRequest } from "@/lib/api/redis-keys-route";
import { readKeyMeta, readMetaRequest } from "@/lib/redis-keys/scan";

export const dynamic = "force-dynamic";

/**
 * TYPE, TTL and MEMORY USAGE for the keys the browser has on screen (StorageBase fork).
 *
 * Body: the connection, `database` and `keys` (at most 100 names). Answers `{ entries }`, one per
 * distinct key; a refused TTL or MEMORY USAGE is null for that key rather than a failed request.
 */
export async function POST(req: NextRequest) {
  return handleRedisKeysRequest(req, "api/redis/keys/meta", "redis.keys.meta", {
    parse: readMetaRequest,
    run: async (runner, request) => ({ entries: await readKeyMeta(runner, request.keys) }),
    counts: (result) => ({ keysDescribed: result.entries.length }),
  });
}
