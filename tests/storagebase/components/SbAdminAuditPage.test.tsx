import "../../setup-dom";

import { mock } from "bun:test";
import * as realAuth from "@/lib/auth";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({
    role: "admin",
    username: "admin@libredb.org",
  }),
);

mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
}));

// The page renders the client component; its own behaviour is covered by
// AuditPage.test.tsx, so it is stubbed here to keep this file about the ROLE GATE.
mock.module("@/components/storagebase/admin/AuditPage", () => ({
  AuditPage: () => <div data-testid="sb-audit-page">AuditPage</div>,
}));

const { default: SbAdminAuditPage } = await import("@/app/(storagebase)/sb-admin/audit/page");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";

/**
 * /sb-admin/audit's role gate: src/proxy.ts JWT-protects the path but role-gates only /admin, so
 * the page checks the role itself, server-side, through upstream's own getSession().
 */

describe("SbAdminAuditPage", () => {
  afterEach(() => {
    cleanup();
    mockGetSession.mockClear();
  });

  test("renders the audit page for an admin session", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin@libredb.org" }));
    const view = render(<>{await SbAdminAuditPage()}</>);
    expect(view.getByTestId("sb-admin-audit")).not.toBeNull();
    expect(view.getByTestId("sb-audit-page")).not.toBeNull();
  });

  test("refuses a non-admin session with the admin-required message, and renders no page", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
    const view = render(<>{await SbAdminAuditPage()}</>);
    expect(view.getByTestId("sb-admin-audit-denied")).not.toBeNull();
    expect(view.getByText("Admin access required.")).not.toBeNull();
    expect(view.queryByTestId("sb-audit-page")).toBeNull();
  });

  test("refuses a sessionless render the same way", async () => {
    mockGetSession.mockImplementation(async () => null);
    const view = render(<>{await SbAdminAuditPage()}</>);
    expect(view.getByTestId("sb-admin-audit-denied")).not.toBeNull();
    expect(view.queryByTestId("sb-audit-page")).toBeNull();
  });
});
