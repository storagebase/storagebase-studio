import { clientAddress } from "@/lib/api/client-address";
import { readTrustProxyHeaders } from "@/lib/security/config";
import type { StoragebaseAuditEventInput } from "./types";

/**
 * Where a fork-route request came from, as a fork audit event records it (StorageBase fork): the
 * resolved client address, the raw forwarded chain it was resolved from, and the user agent.
 *
 * The address is `clientAddress`'s - upstream's own derivation, so the fork audit trail and the
 * rate limiter name the same client for the same request, including the TRUSTED_PROXY_HOPS choice
 * of which hop is the real one. No header is parsed here a second time (P4: reuse the upstream
 * helpers rather than re-implementing them).
 *
 * The chain is recorded ONLY while TRUST_PROXY_HEADERS is on, which is the same switch that lets
 * `clientAddress` read it: with it off, the deployment has declared the header self-reported by
 * the client, and recording it would put a value the operator chose to ignore into the trail.
 * Every value here is a hint, never an identity - the same terms as upstream's `ip`. Length bounds
 * are the sink sanitizer's, applied when the event is recorded.
 *
 * This is for fork ROUTES, which hold a request object. The S2 tap has no request: it fills `ip`
 * from the query event input's own `clientIp` and records no chain.
 */
export function storagebaseRequestContext(request: {
  headers: Headers;
}): Pick<StoragebaseAuditEventInput, "ip" | "forwardedFor" | "userAgent"> {
  const ip = clientAddress(request);
  const forwardedFor = readTrustProxyHeaders() ? request.headers.get("x-forwarded-for")?.trim() : undefined;
  const userAgent = request.headers.get("user-agent")?.trim();
  return {
    // clientAddress's "no usable signal" placeholder is not an address.
    ...(ip !== "unknown" ? { ip } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
