import { getSession } from "@/lib/auth";
import { AuditPage } from "@/components/storagebase/admin/AuditPage";

/**
 * /sb-admin/audit (StorageBase fork): the standalone port of the old fork's audit tab extensions.
 *
 * Self-guarded, because the proxy is not: src/proxy.ts JWT-protects every path outside its public
 * list — /sb-admin included — but its ROLE gate matches `/admin` only, so a signed non-admin session
 * would otherwise render this page's shell and meet its first 403 on the API call. The session is
 * read here, server-side, through upstream's own `getSession()`, and a session that is not an
 * admin's answers the same refusal the route does. Upstream's own admin pages gate the role on the
 * client through the workspace-owner gate because they read the browser's workspace copy; this page
 * reads no such copy, so the server-side check is the smaller surface.
 */

export default async function SbAdminAuditPage() {
  const session = await getSession();
  if (session === null || session.role !== "admin") {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6" data-testid="sb-admin-audit-denied">
        <h1 className="text-lg font-semibold text-fg-primary">Admin access required.</h1>
        <p className="text-sm text-fg-muted mt-1">
          Sign in with an administrator account to read the StorageBase audit trail.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6" data-testid="sb-admin-audit">
      <h1 className="text-lg font-semibold text-fg-primary mb-4">StorageBase audit trail</h1>
      <AuditPage />
    </div>
  );
}
