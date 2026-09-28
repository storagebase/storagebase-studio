import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installVaultServer, refuse } from "./vault-server";

import { VaultWorkbench } from "@/components/resources/vault";

describe("VaultWorkbench", () => {
  beforeEach(() => {
    restoreGlobalFetch();
  });

  afterEach(() => cleanup());

  test("renders one tab per declared object type and switches between them", async () => {
    installVaultServer();
    render(<VaultWorkbench connection={connection} isAdmin={false} />);
    expect(screen.getByText("Reading the vault…")).toBeDefined();
    await waitFor(() => screen.getByRole("tab", { name: "Certificates" }));
    expect(screen.getByTestId("vault-tab-secret")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Keys" }));
    await waitFor(() => screen.getByTestId("vault-tab-key"));
    fireEvent.click(screen.getByRole("tab", { name: "Certificates" }));
    await waitFor(() => screen.getByTestId("vault-tab-certificate"));
    // Not an admin: no exclusions notice. The page header names the connection, not the workbench.
    expect(screen.queryByTestId("vault-exclusions-notice")).toBeNull();
    expect(screen.queryByText("Azure Key Vault")).toBeNull();
  });

  test("read-only strips the write flags: no create, edit, delete, recover or purge — reveal stays", async () => {
    const server = installVaultServer();
    render(<VaultWorkbench connection={connection} isAdmin={false} readOnly />);
    await waitFor(() => screen.getByRole("button", { name: "db-password" }));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "db-password" }));
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    expect(screen.getByRole("button", { name: "Reveal" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => screen.getByText("revealed-value"));

    fireEvent.click(screen.getByRole("tab", { name: "Deleted items" }));
    await waitFor(() => screen.getByTestId("vault-deleted-row"));
    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Purge…" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Keys" }));
    await waitFor(() => screen.getByTestId("vault-tab-key"));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Certificates" }));
    await waitFor(() => screen.getByTestId("vault-tab-certificate"));
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(server.count("secret/reveal")).toBe(1);
  });

  test("a vault without keys or certificates shows only what it declares", async () => {
    installVaultServer({
      meta: () => ({ json: { capabilities: { operations: ["vault.secrets", "vault.secret.reveal"] } } }),
    });
    render(<VaultWorkbench connection={connection} isAdmin={false} />);
    await waitFor(() => screen.getByRole("tab", { name: "Secrets" }));
    expect(screen.queryByRole("tab", { name: "Keys" })).toBeNull();
  });

  test("a vault that declares no object types says so", async () => {
    installVaultServer({ meta: () => ({ json: { capabilities: { operations: ["tree"] } } }) });
    render(<VaultWorkbench connection={connection} isAdmin={false} />);
    await waitFor(() => screen.getByText("This vault declares no browsable objects."));
  });

  test("an unreadable vault shows the reason and retries", async () => {
    let fail = true;
    const server = installVaultServer({
      meta: (body, method) =>
        fail
          ? refuse(502, "vault unreachable")(body, method)
          : { json: { capabilities: { operations: ["vault.secrets"] } } },
    });
    render(<VaultWorkbench connection={connection} isAdmin={false} />);
    await waitFor(() => screen.getByText("vault unreachable"));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => screen.getByRole("tab", { name: "Secrets" }));
    expect(server.count("meta")).toBe(2);
  });

  test("admins see how many exclusion rules apply, decided by the server, with the way to Admin", async () => {
    const server = installVaultServer();
    render(<VaultWorkbench connection={connection} isAdmin />);
    const notice = await screen.findByTestId("vault-exclusions-notice");
    expect(notice.textContent).toContain("2 exclusion rules apply to this vault");
    expect(screen.getByRole("link", { name: "Admin › Access" }).getAttribute("href")).toBe(
      "/admin/access?tab=vault-exclusions",
    );
    // The connection is named the way every vault route names it; nothing about the vault's address.
    expect(server.last("exclusions/applicable")?.body).toEqual({ connection });
  });

  test("the notice reads one rule, no rules, and a refusal", async () => {
    for (const [answer, sentence] of [
      [{ json: { applicableRules: 1 } }, "1 exclusion rule applies"],
      [{ json: { applicableRules: 0 } }, "No exclusion rules apply"],
    ] as const) {
      installVaultServer({ "exclusions/applicable": () => answer });
      render(<VaultWorkbench connection={connection} isAdmin />);
      expect((await screen.findByTestId("vault-exclusions-notice")).textContent).toContain(sentence);
      cleanup();
    }
    installVaultServer({ "exclusions/applicable": refuse(502, "rules unreadable") });
    render(<VaultWorkbench connection={connection} isAdmin />);
    await waitFor(() => screen.getByText("rules unreadable"));
  });
});
