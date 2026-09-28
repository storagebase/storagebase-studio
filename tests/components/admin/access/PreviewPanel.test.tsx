import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockToastError } from "../../../helpers/mock-sonner";
import { resetMockSearchParams, setMockSearchParams } from "../../../helpers/mock-navigation";
import { installFetchRouter } from "./fetch-router";

/** The access preview and the Access section shell (StorageBase fork). */

const { PreviewPanel } = await import("@/components/admin/access/PreviewPanel");
const { AccessAdmin } = await import("@/components/admin/access/AccessAdmin");
const { default: AdminAccessPage } = await import("@/app/admin/access/page");

beforeEach(() => mockToastError.mockClear());
afterEach(() => {
  cleanup();
  resetMockSearchParams();
});

describe("PreviewPanel", () => {
  test("sends the role values split on commas and spaces, and renders both tables", async () => {
    const router = installFetchRouter({
      "POST /api/admin/access/preview": {
        body: {
          subject: { role: "user", appRoles: ["Team.Payments.Read", "Team.Ops.Write"] },
          databases: [
            {
              id: "d",
              name: "Orders",
              type: "postgres",
              permission: "read",
              via: "binding",
              roles: ["Team.Payments.Read"],
              groups: ["Payments"],
            },
          ],
          resources: [],
        },
      },
    });
    const { getByLabelText, getByText, findByText } = render(<PreviewPanel />);
    fireEvent.change(getByLabelText("App role values"), { target: { value: " Team.Payments.Read, Team.Ops.Write " } });
    fireEvent.click(getByText("Preview access"));
    expect(await findByText("Orders")).not.toBeNull();
    expect(getByText("Team.Payments.Read via Payments")).not.toBeNull();
    expect(getByText("None.")).not.toBeNull();
    expect(getByText(/As user with Team.Payments.Read, Team.Ops.Write/)).not.toBeNull();
    expect(router.calls[0].body).toEqual({ roles: ["Team.Payments.Read", "Team.Ops.Write"], studioRole: "user" });
  });

  test("as an admin with no roles: the bypass is named", async () => {
    const router = installFetchRouter({
      "POST /api/admin/access/preview": {
        body: {
          subject: { role: "admin", appRoles: [] },
          databases: [],
          resources: [
            {
              id: "r",
              name: "Vault",
              type: "azure-key-vault",
              permission: "admin",
              via: "admin-bypass",
              roles: [],
              groups: [],
            },
          ],
        },
      },
    });
    const { getByLabelText, getByText, findByText } = render(<PreviewPanel />);
    fireEvent.change(getByLabelText("Studio role"), { target: { value: "admin" } });
    fireEvent.click(getByText("Preview access"));
    expect(await findByText("admin bypass")).not.toBeNull();
    expect(getByText(/no app roles/)).not.toBeNull();
    expect(router.calls[0].body).toEqual({ roles: [], studioRole: "admin" });
    fireEvent.change(getByLabelText("Studio role"), { target: { value: "user" } });
    expect((getByLabelText("Studio role") as HTMLSelectElement).value).toBe("user");
  });

  test("a refused preview toasts", async () => {
    installFetchRouter({ "POST /api/admin/access/preview": { status: 403, body: { error: "Unauthorized" } } });
    const { getByText } = render(<PreviewPanel />);
    fireEvent.click(getByText("Preview access"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Unauthorized"));
  });
});

describe("the Access section", () => {
  const quiet = () =>
    installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
      "GET /api/admin/access/auth-settings": {
        body: {
          settings: { entraEnabled: false, localLogin: "enabled", source: "env" },
          entra: null,
          test: null,
          storeAvailable: true,
        },
      },
    });

  test("opens on Groups, with every tab offered", async () => {
    quiet();
    const { getByTestId, findByText, getByRole } = render(<AdminAccessPage />);
    expect(getByTestId("admin-content-access")).not.toBeNull();
    expect(await findByText(/No groups yet/)).not.toBeNull();
    for (const name of [
      "Groups",
      "Role bindings",
      "Managed connections",
      "Authentication",
      "Access preview",
      "Vault exclusions",
    ]) {
      expect(getByRole("tab", { name })).not.toBeNull();
    }
  });

  test("returning from a test sign-in opens on Authentication", async () => {
    quiet();
    setMockSearchParams(new URLSearchParams({ entraTest: "ok" }));
    const { findByText } = render(<AccessAdmin />);
    expect(await findByText(/Not configured/)).not.toBeNull();
  });
});
