import type { NextRequest } from "next/server";
import { handleRedisKeysRequest } from "@/lib/api/redis-keys-route";
import { readScanRequest, SCAN_DEADLINE_MS, scanKeys } from "@/lib/redis-keys/scan";

export const dynamic = "force-dynamic";

/**
 * One bounded page of a Redis database's key names, for the key browser (StorageBase fork).
 *
 * Body: the connection (`connection` or `connectionId`, as on `POST /api/db/query`), plus
 * `database`, `cursor` ("0" to start), optional `match` (a Redis glob), optional `type` and
 * optional `limit` (default 10,000, at most 50,000). Answers
 * `{ keys, cursor, truncated, scanned, iterations, stoppedBy }`; a non-"0" cursor is where
 * "Load more" resumes. A cursor SCAN, never KEYS, under a key cap and a wall-clock deadline.
 */
export async function POST(req: NextRequest) {
  return handleRedisKeysRequest(req, "api/redis/keys", "redis.keys.list", {
    parse: readScanRequest,
    run: (runner, request) => scanKeys(runner, { ...request, deadlineMs: SCAN_DEADLINE_MS }),
    counts: (result) => ({
      keysReturned: result.keys.length,
      keysScanned: result.scanned,
      iterations: result.iterations,
      truncated: result.truncated,
    }),
  });
}
