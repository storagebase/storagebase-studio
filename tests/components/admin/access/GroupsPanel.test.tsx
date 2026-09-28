import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { installFetchRouter } from "./fetch-router";

const { GroupsPanel } = await import("@/components/admin/access/GroupsPanel");

const GROUP = { id: "payments", name: "Payments", description: "Team data", connectionCount: 2, bindingCount: 1 };

beforeEach(() => {
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});
afterEach(() => cleanup());

describe("GroupsPanel", () => {
  test("lists groups with their counts", async () => {
    installFetchRouter({ "GET /api/admin/access/groups": { body: { groups: [GROUP], storeAvailable: true } } });
    const { findByText, getByText } = render(<GroupsPanel />);
    expect(await findByText("Payments")).not.toBeNull();
    expect(getByText(/2 connection\(s\) · 1 binding\(s\) · Team data/)).not.toBeNull();
  });

  test("an empty list says what to do next", async () => {
    installFetchRouter({ "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } } });
    const { findByText } = render(<GroupsPanel />);
    expect(await findByText(/No groups yet/)).not.toBeNull();
  });

  test("no server storage renders the store notice", async () => {
    installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: false, message: "Needs storage" } },
    });
    const { findByRole } = render(<GroupsPanel />);
    expect((await findByRole("note")).textContent).toBe("Needs storage");
  });

  test("a failed load toasts the server's sentence", async () => {
    installFetchRouter({ "GET /api/admin/access/groups": { status: 403, body: { error: "Unauthorized" } } });
    render(<GroupsPanel />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Unauthorized"));
  });

  test("creates a group with an optional id, then reloads and tells the parent", async () => {
    const router = installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
      "POST /api/admin/access/groups": { status: 201, body: { group: GROUP } },
    });
    let changed = 0;
    const { findByLabelText, getByLabelText, getByText } = render(<GroupsPanel onChanged={() => changed++} />);
    fireEvent.change(await findByLabelText("Id (optional)"), { target: { value: " payments " } });
    fireEvent.change(getByLabelText("Name"), { target: { value: "Payments" } });
    fireEvent.change(getByLabelText("Description"), { target: { value: "Team data" } });
    fireEvent.click(getByText("Create group"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Group created"));
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({
      id: "payments",
      name: "Payments",
      description: "Team data",
    });
    expect(changed).toBe(1);
  });

  test("a blank name is refused before any request, and an id is omitted when blank", async () => {
    const router = installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
      "POST /api/admin/access/groups": { status: 409, body: { error: 'A group named "X" already exists' } },
    });
    const { findByLabelText, getByText, getByLabelText } = render(<GroupsPanel />);
    fireEvent.click(await findByLabelText("Name").then(() => getByText("Create group")));
    expect(mockToastError).toHaveBeenCalledWith("A group needs a name");
    fireEvent.change(getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(getByText("Create group"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('A group named "X" already exists'));
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({ name: "X", description: "" });
  });

  test("edits a group in place, and cancel returns to the create form", async () => {
    const router = installFetchRouter({
      "GET /api/admin/access/groups": {
        body: { groups: [{ ...GROUP, description: undefined }], storeAvailable: true },
      },
      "PUT /api/admin/access/groups": { body: { group: GROUP } },
    });
    const { findByLabelText, getByLabelText, getByText, queryByText } = render(<GroupsPanel />);
    fireEvent.click(await findByLabelText("Edit Payments"));
    expect((getByLabelText("Id (optional)") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Save group")).toBeNull();
    fireEvent.click(getByLabelText("Edit Payments"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Payments EU" } });
    fireEvent.click(getByText("Save group"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Group updated"));
    expect(router.calls.find((call) => call.method === "PUT")?.body).toEqual({
      id: "payments",
      name: "Payments EU",
      description: "",
    });
  });

  test("deletes only after a confirmation that states the consequence", async () => {
    const router = installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [GROUP], storeAvailable: true } },
      "DELETE /api/admin/access/groups": { body: { group: GROUP } },
    });
    const { findByLabelText, getByText, queryByText, getByLabelText } = render(<GroupsPanel />);
    fireEvent.click(await findByLabelText("Delete Payments"));
    expect(getByText(/Deletes its bindings/)).not.toBeNull();
    fireEvent.click(getByText("Keep"));
    expect(queryByText(/Deletes its bindings/)).toBeNull();
    fireEvent.click(getByLabelText("Edit Payments"));
    fireEvent.click(getByLabelText("Delete Payments"));
    fireEvent.click(getByText("Confirm delete"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Group deleted"));
    expect(
      router.calls.some((call) => call.method === "DELETE" && call.path === "/api/admin/access/groups?id=payments"),
    ).toBe(true);
    expect(queryByText("Save group")).toBeNull();
  });

  test("a refused delete toasts the reason", async () => {
    installFetchRouter({
      "GET /api/admin/access/groups": { body: { groups: [GROUP], storeAvailable: true } },
      "DELETE /api/admin/access/groups": { status: 404, body: {} },
    });
    const { findByLabelText, getByText } = render(<GroupsPanel />);
    fireEvent.click(await findByLabelText("Delete Payments"));
    fireEvent.click(getByText("Confirm delete"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Request failed (404)"));
  });
});
