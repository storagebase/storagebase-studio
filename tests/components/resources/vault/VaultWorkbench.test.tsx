import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installVaultServer, refuse } from "./vault-server";

import { VaultWorkbench } from "@/components/resources/vault";

describe("VaultWorkbench", () => {
  const onClose = mock(() => {});
  const onEditConnection = mock((_c: unknown) => {});

  beforeEach(() => {
    onClose.mockClear();
    onEditConnection.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => cleanup());

  test("renders one tab per declared object type and switches between them", async () => {
    installVaultServer();
    render(
      <VaultWorkbench connection={connection} isAdmin={false} onClose={onClose} onEditConnection={onEditConnection} />,
    );
    expect(screen.getByText("Reading the vault…")).toBeDefined();
    await waitFor(() => screen.getByRole("tab", { name: "Certificates" }));
    expect(screen.getByText("Azure Key Vault")).toBeDefined();
    expect(screen.getByTestId("vault-tab-secret")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Keys" }));
    await waitFor(() => screen.getByTestId("vault-tab-key"));
    fireEvent.click(screen.getByRole("tab", { name: "Certificates" }));
    await waitFor(() => screen.getByTestId("vault-tab-certificate"));
    // Not an admin: no exclusions control.
    expect(screen.queryByRole("button", { name: "Exclusions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(onEditConnection).toHaveBeenCalledWith(connection);
    fireEvent.click(screen.getByRole("button", { name: "Close workbench" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a vault without keys or certificates shows only what it declares", async () => {
    installVaultServer({
      meta: () => ({ json: { capabilities: { operations: ["vault.secrets", "vault.secret.reveal"] } } }),
    });
    render(<VaultWorkbench connection={connection} isAdmin={false} onClose={onClose} />);
    await waitFor(() => screen.getByRole("tab", { name: "Secrets" }));
    expect(screen.queryByRole("tab", { name: "Keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
  });

  test("a vault that declares no object types says so", async () => {
    installVaultServer({ meta: () => ({ json: { capabilities: { operations: ["tree"] } } }) });
    render(<VaultWorkbench connection={connection} isAdmin={false} onClose={onClose} />);
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
    render(<VaultWorkbench connection={connection} isAdmin={false} onClose={onClose} />);
    await waitFor(() => screen.getByText("vault unreachable"));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => screen.getByRole("tab", { name: "Secrets" }));
    expect(server.count("meta")).toBe(2);
  });

  test("admins toggle the exclusions panel", async () => {
    installVaultServer();
    render(<VaultWorkbench connection={connection} isAdmin onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Exclusions" }));
    await waitFor(() => screen.getByTestId("vault-exclusions"));
    fireEvent.click(screen.getByRole("button", { name: "Exclusions" }));
    expect(screen.queryByTestId("vault-exclusions")).toBeNull();
  });
});
