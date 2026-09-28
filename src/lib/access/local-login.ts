import { NextResponse } from "next/server";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { loadAuthSettings } from "./auth-settings";

/**
 * The local-login policy at `POST /api/auth/login` (StorageBase fork), the break-glass rule for
 * email/password once Entra carries everyday sign-in:
 *
 * - `enabled`: unchanged upstream behaviour.
 * - `admin-only`: only an ADMIN account may sign in with a password. A non-admin account with the
 *   right password gets the same uniform 401 as a wrong one, so the policy cannot become an oracle
 *   for which accounts exist or which password is right.
 * - `disabled`: every attempt is refused before the body is read (403), with a sentence that points
 *   at single sign-on. The refusal's audit line is metered like every other anonymous denial.
 */

const ROUTE = "POST /api/auth/login";
export const LOCAL_LOGIN_DISABLED_MESSAGE = "Email and password sign-in is disabled. Sign in with Microsoft instead.";

export interface LocalLoginGate {
  /** Set when the policy refuses every local attempt. */
  refused?: NextResponse;
  /** Whether an account with this role may finish a local sign-in. */
  allows(role: string): boolean;
}

export async function localLoginGate(ip: string): Promise<LocalLoginGate> {
  const { localLogin } = await loadAuthSettings();
  if (localLogin === "disabled") {
    const notice = consumeRateLimit("anon", ip);
    if (notice.allowed || notice.tripped) {
      try {
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: ROUTE,
          user: "anonymous",
          result: "failure",
          reason: "local_login_disabled",
          ip,
          authProvider: "local",
        });
      } catch (auditError) {
        logger.error("Failed to record login_failure audit event", auditError, { route: ROUTE });
      }
    }
    return {
      refused: NextResponse.json({ success: false, message: LOCAL_LOGIN_DISABLED_MESSAGE }, { status: 403 }),
      allows: () => false,
    };
  }
  return { allows: (role) => localLogin !== "admin-only" || role === "admin" };
}
