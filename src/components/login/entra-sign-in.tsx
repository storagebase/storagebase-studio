"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/config/base-path";
import { Button } from "@/components/ui/button";
import type { AuditReason } from "@/lib/audit";

/**
 * "Sign in with Microsoft" (StorageBase fork), rendered by the login form when the sign-in switch
 * has Entra on. The page is unauthenticated, so an error is shown as one fixed sentence per code
 * the Entra routes redirect with — never anything the identity provider said.
 */

/** The four-square mark, drawn inline so the login page loads no third-party asset. */
function MicrosoftMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 21 21" className="h-4 w-4">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function entraErrorMessage(code: string): string {
  switch (code) {
    case "entra_disabled" satisfies AuditReason:
      return "Sign-in with Microsoft is turned off on this server. Contact your administrator.";
    case "entra_tenant_mismatch" satisfies AuditReason:
      return "That Microsoft account belongs to a different organization.";
    case "entra_role_not_allowed" satisfies AuditReason:
      return "Your account has not been given access to StorageBase Studio. Ask your administrator to assign you an app role.";
    case "oidc_config" satisfies AuditReason:
      return "Single sign-on is not configured correctly on this server. Contact your administrator.";
    case "oidc_discovery" satisfies AuditReason:
      return "Microsoft sign-in could not be reached. Try again later, or contact your administrator if this continues.";
    default:
      return "Authentication failed. Please try again.";
  }
}

export function EntraSignIn({
  error,
  localBelow,
  adminOnly,
}: {
  /** The `?error=` code, if the last attempt failed. */
  error: string | null;
  /** Whether the email/password form follows, so a divider introduces it. */
  localBelow: boolean;
  /** Whether that form is for administrators only (break-glass). */
  adminOnly: boolean;
}) {
  const [redirecting, setRedirecting] = useState(false);
  return (
    <div className="space-y-4" data-testid="entra-sign-in">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {entraErrorMessage(error)}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full h-11 text-base font-medium gap-2"
        disabled={redirecting}
        onClick={() => {
          setRedirecting(true);
          window.location.href = withBasePath("/api/auth/entra/login");
        }}
      >
        <MicrosoftMark />
        {redirecting ? "Redirecting..." : "Sign in with Microsoft"}
      </Button>
      {localBelow && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span>{adminOnly ? "Administrator sign-in" : "or sign in with email"}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
    </div>
  );
}
