import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { ALL_FLAGS, connection, installVaultServer, refuse } from "./vault-server";
import type { ResourceOperation } from "@/lib/resources/types";

import { VaultObjectsTab } from "@/components/resources/vault/VaultObjectsTab";

const FLAGS = new Set(ALL_FLAGS) as ReadonlySet<ResourceOperation>;

function renderTab(type: "secret" | "key" | "certificate", flags: ReadonlySet<ResourceOperation> = FLAGS) {
  return render(<VaultObjectsTab connection={connection} type={type} flags={flags} />);
}

describe("VaultObjectsTab", () => {
  beforeEach(() => restoreGlobalFetch());
  afterEach(() => cleanup());

  test("secrets list with status, content type, dates and tags; filter by name or tag", async () => {
    installVaultServer();
    renderTab("secret");
    expect(screen.getByText("Listing secrets…")).toBeDefined();
    await waitFor(() => expect(screen.getAllByTestId("vault-object-row")).toHaveLength(3));
    const [first, second, third] = screen.getAllByTestId("vault-object-row");
    expect(within(first).getByText("Enabled")).toBeDefined();
    expect(within(first).getByText("text/plain")).toBeDefined();
    expect(within(first).getByText("2027-01-01 00:00:00 UTC")).toBeDefined();
    expect(within(first).getByText("team=platform")).toBeDefined();
    expect(within(second).getByText("Disabled")).toBeDefined();
    expect(within(second).getByText("Never")).toBeDefined();
    expect(within(third).getAllByText("—").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Filter secrets"), { target: { value: "PLATFORM" } });
    expect(screen.getAllByTestId("vault-object-row")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Filter secrets"), { target: { value: "zzz" } });
    expect(screen.getByText("No secrets match.")).toBeDefined();
  });

  test("keys and certificates show their own columns", async () => {
    installVaultServer();
    renderTab("key");
    await waitFor(() => screen.getByText("2048"));
    expect(screen.getByText("P-256")).toBeDefined();
    cleanup();
    renderTab("certificate");
    await waitFor(() => screen.getByText("CN=example.test"));
    expect(screen.getByText("AB01")).toBeDefined();
  });

  test("selecting a row opens its detail; no value is fetched on open", async () => {
    const server = installVaultServer();
    renderTab("secret");
    expect(screen.getByText("Select an object to see its details.")).toBeDefined();
    await waitFor(() => screen.getByRole("button", { name: "db-password" }));
    fireEvent.click(screen.getByRole("button", { name: "db-password" }));
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    expect(server.count("secret/reveal")).toBe(0);
    expect(screen.getByText("Value hidden")).toBeDefined();
  });

  test("deleting the selected object clears the detail and re-reads the list", async () => {
    const server = installVaultServer();
    renderTab("secret");
    await waitFor(() => screen.getByRole("button", { name: "db-password" }));
    fireEvent.click(screen.getByRole("button", { name: "db-password" }));
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    const listingsBefore = server.count("objects");

    const detail = within(screen.getByTestId("vault-object-detail"));
    fireEvent.click(detail.getByRole("button", { name: "Delete" }));
    fireEvent.click(detail.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Select an object to see its details.")).toBeDefined());
    expect(server.last("object/delete")?.body).toMatchObject({ type: "secret", name: "db-password" });
    await waitFor(() => expect(server.count("objects")).toBeGreaterThan(listingsBefore));
  });

  test("a failed listing shows the reason and a retry; refresh re-reads", async () => {
    let fail = true;
    const server = installVaultServer({
      objects: (body, method) =>
        fail ? refuse(502, "list failed")(body, method) : { json: { objects: [], truncated: true } },
    });
    renderTab("secret");
    await waitFor(() => screen.getByText("list failed"));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => screen.getByText("Only the first page of objects is listed."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(server.count("objects")).toBe(3));
  });

  test("create opens the per-type form and selects what it made", async () => {
    const server = installVaultServer();
    renderTab("secret");
    await waitFor(() => screen.getAllByTestId("vault-object-row"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "new-secret" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    expect(server.last("secret/save")?.body).toMatchObject({ name: "new-secret", value: "v" });
    expect(screen.queryByTestId("vault-secret-form")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("vault-secret-form")).toBeNull();
    cleanup();

    renderTab("key");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByTestId("vault-key-form")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    cleanup();

    renderTab("certificate");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByTestId("vault-certificate-form")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("vault-certificate-form")).toBeNull();
  });

  test("without write flags there is no create, and without soft delete no Deleted view", async () => {
    installVaultServer();
    renderTab("secret", new Set(["vault.secrets"]) as ReadonlySet<ResourceOperation>);
    await waitFor(() => screen.getAllByTestId("vault-object-row"));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Deleted items" })).toBeNull();
  });

  test("the Deleted view lists, recovers and purges with a typed confirm", async () => {
    const server = installVaultServer();
    renderTab("secret");
    fireEvent.click(screen.getByRole("tab", { name: "Deleted items" }));
    await waitFor(() => screen.getByTestId("vault-deleted-row"));
    expect(screen.getByText("2026-12-01 00:00:00 UTC")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    await waitFor(() => screen.getByText("Recovered old-secret."));
    expect(server.last("deleted/recover")?.body).toMatchObject({ type: "secret", name: "old-secret" });

    fireEvent.click(screen.getByRole("button", { name: "Purge…" }));
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    expect(screen.getByText(/Purging permanently deletes old-secret and cannot be undone/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Type old-secret to confirm"), { target: { value: "old-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    await waitFor(() => screen.getByText("Purged old-secret."));
    expect(server.last("deleted/purge")?.body).toMatchObject({ name: "old-secret", confirm: "old-secret" });

    fireEvent.click(screen.getByRole("tab", { name: "Secrets" }));
    await waitFor(() => screen.getAllByTestId("vault-object-row"));
  });

  test("the Deleted view says when empty, and shows refusals", async () => {
    installVaultServer({
      deleted: () => ({
        json: { deleted: [{ type: "secret", name: "x", deletedOn: null, scheduledPurgeDate: null }] },
      }),
      "deleted/recover": refuse(409, "purge protection is on"),
    });
    renderTab("secret");
    fireEvent.click(screen.getByRole("tab", { name: "Deleted items" }));
    await waitFor(() => screen.getByTestId("vault-deleted-row"));
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    await waitFor(() => screen.getByText("purge protection is on"));
    cleanup();

    installVaultServer({ deleted: () => ({ json: { deleted: [] } }) });
    renderTab("secret");
    fireEvent.click(screen.getByRole("tab", { name: "Deleted items" }));
    await waitFor(() => screen.getByText("No deleted items."));
    cleanup();

    installVaultServer({ deleted: refuse(400, "no soft delete") });
    renderTab("secret");
    fireEvent.click(screen.getByRole("tab", { name: "Deleted items" }));
    await waitFor(() => screen.getByText("no soft delete"));
  });
});
