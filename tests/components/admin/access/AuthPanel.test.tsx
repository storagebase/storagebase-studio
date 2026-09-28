import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { resetMockSearchParams, setMockSearchParams } from "../../../helpers/mock-navigation";
import { installFetchRouter } from "./fetch-router";

/** The Authentication tab (StorageBase fork): the Entra summary, the test sign-in, and the switch. */

const { AuthPanel } = await import("@/components/admin/access/AuthPanel");

const ENTRA = {
  tenantId: "00000000-0000-0000-0000-000000000000",
  clientId: "11111111-1111-1111-1111-111111111111",
  redirectUri: null,
  adminRoles: ["StorageBase.Admin"],
  allowedRoles: [],
  sessionHours: 8,
  error: null,
};

function answer(overrides: Record<string, unknown> = {}) {
  return {
    settings: { entraEnabled: false, localLogin: "enabled", source: "env" },
    entra: ENTRA,
    test: null,
    storeAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});
afterEach(() => {
  cleanup();
  resetMockSearchParams();
});

describe("AuthPanel", () => {
  test("summarises the Entra configuration and says no test has run", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer() } });
    const { findByText, getByText } = render(<AuthPanel />);
    expect(await findByText(ENTRA.tenantId)).not.toBeNull();
    expect(getByText("derived from the request")).not.toBeNull();
    expect(getByText("any")).not.toBeNull();
    expect(getByText("8 h")).not.toBeNull();
    expect(getByText("No test sign-in yet.")).not.toBeNull();
    expect(getByText(/from the environment/)).not.toBeNull();
  });

  test("an explicit redirect URI and allowed roles are shown as configured", async () => {
    installFetchRouter({
      "GET /api/admin/access/auth-settings": {
        body: answer({ entra: { ...ENTRA, redirectUri: "http://127.0.0.1:8080/cb", allowedRoles: ["Team.A.Read"] } }),
      },
    });
    const { findByText, getByText } = render(<AuthPanel />);
    expect(await findByText("http://127.0.0.1:8080/cb")).not.toBeNull();
    expect(getByText("Team.A.Read")).not.toBeNull();
  });

  test("unconfigured Entra: says what to set, the test and the switch are disabled", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer({ entra: null }) } });
    const { findByText, getByText, getByLabelText } = render(<AuthPanel />);
    expect(await findByText(/Not configured/)).not.toBeNull();
    expect((getByText("Test sign-in with Microsoft").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText(/Offer/) as HTMLInputElement).disabled).toBe(true);
  });

  test("a configuration error is shown as one", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer({ entra: { error: "not a GUID" } }) } });
    const { findByText } = render(<AuthPanel />);
    expect(await findByText("Configuration error: not a GUID")).not.toBeNull();
  });

  test("the last test's claims, or its failure", async () => {
    installFetchRouter({
      "GET /api/admin/access/auth-settings": {
        body: answer({
          test: {
            ok: true,
            at: "2026-09-25T10:00:00.000Z",
            by: "admin",
            claims: { roles: ["StorageBase.Admin"], upn: "a@example.com", studioRole: "admin" },
          },
        }),
      },
    });
    const ok = render(<AuthPanel />);
    expect((await ok.findByRole("status")).textContent).toContain("app roles: StorageBase.Admin");
    cleanup();

    installFetchRouter({
      "GET /api/admin/access/auth-settings": {
        body: answer({
          test: { ok: true, at: "2026-09-25T10:00:00.000Z", by: "admin", claims: { roles: [], studioRole: "user" } },
        }),
      },
    });
    const none = render(<AuthPanel />);
    expect((await none.findByRole("status")).textContent).toContain("app roles: none");
    cleanup();

    installFetchRouter({
      "GET /api/admin/access/auth-settings": {
        body: answer({
          test: { ok: false, at: "2026-09-25T10:00:00.000Z", by: "admin", error: "entra_tenant_mismatch" },
        }),
      },
    });
    const failed = render(<AuthPanel />);
    expect((await failed.findByRole("status")).textContent).toContain("Last test failed (entra_tenant_mismatch)");
  });

  test("the test button starts an administrator's test sign-in", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer() } });
    const { findByText } = render(<AuthPanel />);
    const saved = window.location.href;
    fireEvent.click(await findByText("Test sign-in with Microsoft"));
    expect(window.location.href).toContain("/api/auth/entra/login?test=1");
    window.location.href = saved;
  });

  test("saves the switch and the policy, then shows the saved source", async () => {
    let settings: Record<string, unknown> = { entraEnabled: false, localLogin: "enabled", source: "env" };
    const router = installFetchRouter({
      "GET /api/admin/access/auth-settings": () => ({ body: answer({ settings }) }),
      "POST /api/admin/access/auth-settings": () => {
        settings = {
          entraEnabled: true,
          localLogin: "admin-only",
          source: "store",
          updatedBy: "admin",
          updatedAt: "t",
        };
        return { body: { settings } };
      },
    });
    const { findByLabelText, getByLabelText, getByText, findByText } = render(<AuthPanel />);
    fireEvent.click(await findByLabelText(/Offer/));
    fireEvent.click(getByLabelText(/admin-only/));
    fireEvent.click(getByText("Save sign-in settings"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Sign-in settings saved"));
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({
      entraEnabled: true,
      localLogin: "admin-only",
    });
    expect(await findByText(/saved setting \(admin, t\)/)).not.toBeNull();
  });

  test("the server's refusal is shown verbatim", async () => {
    installFetchRouter({
      "GET /api/admin/access/auth-settings": { body: answer() },
      "POST /api/admin/access/auth-settings": { status: 400, body: { error: "Run a successful test sign-in first" } },
    });
    const { findByText } = render(<AuthPanel />);
    fireEvent.click(await findByText("Save sign-in settings"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Run a successful test sign-in first"));
  });

  test("without server storage the switch follows the environment and cannot be saved", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer({ storeAvailable: false }) } });
    const { findByRole, getByText } = render(<AuthPanel />);
    expect((await findByRole("note")).textContent).toContain("follows the environment");
    expect((getByText("Save sign-in settings").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed load toasts", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { status: 403, body: { error: "Unauthorized" } } });
    render(<AuthPanel />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Unauthorized"));
  });

  test("returning from a test sign-in announces its outcome", async () => {
    installFetchRouter({ "GET /api/admin/access/auth-settings": { body: answer() } });
    setMockSearchParams(new URLSearchParams({ entraTest: "ok" }));
    render(<AuthPanel />);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Test sign-in with Microsoft succeeded"));
    cleanup();
    setMockSearchParams(new URLSearchParams({ entraTest: "failed" }));
    render(<AuthPanel />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Test sign-in with Microsoft failed"));
  });
});
