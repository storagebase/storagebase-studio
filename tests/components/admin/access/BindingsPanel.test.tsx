import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { installFetchRouter } from "./fetch-router";

const { BindingsPanel, PERMISSION_HELP } = await import("@/components/admin/access/BindingsPanel");

const GROUPS = {
  groups: [{ id: "payments", name: "Payments", connectionCount: 0, bindingCount: 1 }],
  storeAvailable: true,
};
const BINDING = {
  id: "b1",
  appRoleValue: "Team.Payments.Read",
  groupId: "payments",
  groupName: "Payments",
  permission: "read",
  createdBy: "admin",
};
const LIST = {
  bindings: [BINDING],
  seenRoles: [{ value: "Team.Payments.Write", lastSeenAt: "2026-09-24T00:00:00.000Z" }],
  storeAvailable: true,
};

beforeEach(() => {
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});
afterEach(() => cleanup());

describe("BindingsPanel", () => {
  test("lists bindings and offers the role values recent sign-ins presented", async () => {
    installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
    });
    const { findByText, container, getByText } = render(<BindingsPanel />);
    expect(await findByText("Team.Payments.Read")).not.toBeNull();
    expect(getByText("by admin")).not.toBeNull();
    expect(container.querySelector('datalist option[value="Team.Payments.Write"]')).not.toBeNull();
  });

  test("no bindings and no groups: both say so", async () => {
    installFetchRouter({
      "GET /api/admin/access/bindings": { body: { ...LIST, bindings: [] } },
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
    });
    const { findByText, getByText } = render(<BindingsPanel />);
    expect(await findByText(/No bindings yet/)).not.toBeNull();
    expect(getByText("Create a connection group first.")).not.toBeNull();
  });

  test("no server storage renders the notice; a failed load toasts", async () => {
    installFetchRouter({
      "GET /api/admin/access/bindings": {
        body: { bindings: [], seenRoles: [], storeAvailable: false, message: "Needs storage" },
      },
      "GET /api/admin/access/groups": { body: GROUPS },
    });
    const first = render(<BindingsPanel />);
    expect((await first.findByRole("note")).textContent).toBe("Needs storage");
    first.unmount();
    installFetchRouter({
      "GET /api/admin/access/bindings": { status: 500, body: { error: "boom" } },
      "GET /api/admin/access/groups": { body: GROUPS },
    });
    render(<BindingsPanel />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"));
  });

  test("the permission help follows the selection", async () => {
    installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
    });
    const { findByLabelText, getByText } = render(<BindingsPanel />);
    fireEvent.change(await findByLabelText("Permission"), { target: { value: "admin" } });
    expect(getByText(PERMISSION_HELP.admin)).not.toBeNull();
  });

  test("refuses an empty or spaced role value and a missing group before any request", async () => {
    const router = installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
    });
    const { findByLabelText, getByText, getByLabelText } = render(<BindingsPanel />);
    await findByLabelText("App role value");
    fireEvent.click(getByText("Save binding"));
    expect(mockToastError).toHaveBeenLastCalledWith("An app-role value is required and has no spaces or commas");
    fireEvent.change(getByLabelText("App role value"), { target: { value: "Team Payments" } });
    fireEvent.click(getByText("Save binding"));
    expect(mockToastError).toHaveBeenCalledTimes(2);
    fireEvent.change(getByLabelText("App role value"), { target: { value: "Team.Payments.Read" } });
    fireEvent.click(getByText("Save binding"));
    expect(mockToastError).toHaveBeenLastCalledWith("Pick a group");
    expect(router.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("saves a binding (created, then replaced) and reloads", async () => {
    let replaced = false;
    const router = installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
      "POST /api/admin/access/bindings": () => ({ status: replaced ? 200 : 201, body: { binding: BINDING, replaced } }),
    });
    const { findByLabelText, getByText, getByLabelText } = render(<BindingsPanel />);
    const submit = async (value: string) => {
      fireEvent.change(await findByLabelText("App role value"), { target: { value } });
      fireEvent.change(getByLabelText("Group"), { target: { value: "payments" } });
      fireEvent.change(getByLabelText("Permission"), { target: { value: "write" } });
      fireEvent.click(getByText("Save binding"));
    };
    await submit(" Team.Payments.Write ");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Binding created"));
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({
      appRoleValue: "Team.Payments.Write",
      groupId: "payments",
      permission: "write",
    });
    replaced = true;
    await submit("Team.Payments.Write");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Binding updated"));
  });

  test("a refused save toasts the server's sentence", async () => {
    installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
      "POST /api/admin/access/bindings": { status: 400, body: { error: "groupId: group does not exist" } },
    });
    const { findByLabelText, getByText, getByLabelText } = render(<BindingsPanel />);
    fireEvent.change(await findByLabelText("App role value"), { target: { value: "A.B" } });
    fireEvent.change(getByLabelText("Group"), { target: { value: "payments" } });
    fireEvent.click(getByText("Save binding"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("groupId: group does not exist"));
  });

  test("deletes a binding, and a refused delete toasts", async () => {
    let status = 200;
    const router = installFetchRouter({
      "GET /api/admin/access/bindings": { body: LIST },
      "GET /api/admin/access/groups": { body: GROUPS },
      "DELETE /api/admin/access/bindings": () => ({
        status,
        body: status === 200 ? { binding: BINDING } : { error: "gone" },
      }),
    });
    const { findByLabelText } = render(<BindingsPanel />);
    fireEvent.click(await findByLabelText("Delete binding Team.Payments.Read to Payments"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Binding deleted"));
    expect(router.calls.some((call) => call.path === "/api/admin/access/bindings?id=b1")).toBe(true);
    status = 404;
    fireEvent.click(await findByLabelText("Delete binding Team.Payments.Read to Payments"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("gone"));
  });
});
