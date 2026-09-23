import { clientAddress } from "@/lib/api/client-address";
import { readTrustProxyHeaders } from "@/lib/security/config";

/**
 * Where a request came from, as an audit event records it (StorageBase fork): the resolved client
 * address, the raw forwarded chain it was resolved from, and the user agent.
 *
 * The address is `clientAddress`'s - the rate limiter's own derivation, so the audit trail and the
 * limiter name the same client for the same request, including the TRUSTED_PROXY_HOPS choice of
 * which hop is the real one. No header is parsed here a second time.
 *
 * The chain is recorded ONLY while TRUST_PROXY_HEADERS is on, which is the same switch that lets
 * `clientAddress` read it: with it off, the deployment has declared the header self-reported by
 * the client, and recording it would put a value the operator chose to ignore into the trail.
 * Every value here is a hint, never an identity - see `AuditEvent.ip`. Length bounds are the audit
 * sanitizer's (MAX_AUDIT_FIELD_LENGTH), applied when the event is emitted.
 */
export interface AuditRequestFields {
  ip?: string;
  forwardedFor?: string;
  userAgent?: string;
}

export function auditRequestFields(request: { headers: Headers }): AuditRequestFields {
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
