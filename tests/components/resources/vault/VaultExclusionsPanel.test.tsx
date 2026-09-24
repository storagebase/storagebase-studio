import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installVaultServer, refuse } from "./vault-server";

import { VaultExclusionsPanel } from "@/components/resources/vault/VaultExclusionsPanel";

describe("VaultExclusionsPanel", () => {
  beforeEach(() => restoreGlobalFetch());
  afterEach(() => cleanup());

  test("reads the rules for this vault's normalized address, edits, previews and saves", async () => {
    const server = installVaultServer({
      exclusions: (body, method) => ({
        json: {
          rules: method === "PUT" ? body.rules : [{ pattern: "hidden-*", kind: "glob", objectType: "any", note: "" }],
        },
      }),
    });
    render(<VaultExclusionsPanel connection={connection} />);
    expect(screen.getByText("Reading the rules…")).toBeDefined();
    await waitFor(() => expect(screen.getAllByTestId("vault-exclusion-rule")).toHaveLength(1));
    const url = new URL(server.last("exclusions")?.url as string);
    expect(url.searchParams.get("type")).toBe("azure-key-vault");
    expect(url.searchParams.get("address")).toBe("https://example.vault.azure.net");

    fireEvent.change(screen.getByLabelText("Rule 1 pattern"), { target: { value: "^prod-" } });
    fireEvent.change(screen.getByLabelText("Rule 1 kind"), { target: { value: "regex" } });
    fireEvent.change(screen.getByLabelText("Rule 1 object type"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Rule 1 note"), { target: { value: "why" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getAllByTestId("vault-exclusion-rule")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => screen.getByText("Would hide 1 of 3 secrets"));
    expect(server.last("exclusions/preview")?.body.rules).toEqual([
      { pattern: "^prod-", kind: "regex", objectType: "secret", note: "why" },
      { pattern: "", kind: "glob", objectType: "any", note: "" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    expect(screen.queryByTestId("vault-exclusion-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => screen.getByText(/Exclusion rules saved/));
    expect(server.last("exclusions")?.method).toBe("PUT");
    expect(server.last("exclusions")?.body).toMatchObject({
      type: "azure-key-vault",
      address: "https://example.vault.azure.net",
      rules: [{ pattern: "^prod-", kind: "regex", objectType: "secret", note: "why" }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove rule 1" }));
    expect(screen.getByText("No rules: nothing is hidden.")).toBeDefined();
  });

  test("refusals from preview, save and the read are shown", async () => {
    installVaultServer({
      exclusions: (body, method) =>
        method === "PUT" ? refuse(400, "Rule 1: a repeated group")(body, method) : { json: { rules: [] } },
      "exclusions/preview": refuse(403, "Unauthorized. Admin access required."),
    });
    render(<VaultExclusionsPanel connection={connection} />);
    await waitFor(() => screen.getByText("No rules: nothing is hidden."));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => screen.getByText("Unauthorized. Admin access required."));
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => screen.getByText("Rule 1: a repeated group"));
    cleanup();

    installVaultServer({ exclusions: refuse(409, "needs the durable settings store") });
    render(<VaultExclusionsPanel connection={connection} />);
    await waitFor(() => screen.getByText("needs the durable settings store"));
  });
});
