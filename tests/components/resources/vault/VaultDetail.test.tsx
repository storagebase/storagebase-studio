import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { ALL_FLAGS, connection, installVaultServer, refuse } from "./vault-server";
import type { ResourceOperation } from "@/lib/resources/types";

import { VaultObjectDetail } from "@/components/resources/vault/VaultObjectDetail";

const FLAGS = new Set(ALL_FLAGS) as ReadonlySet<ResourceOperation>;

describe("VaultObjectDetail", () => {
  const onChanged = mock(() => {});
  const onDeleted = mock(() => {});
  const writeText = mock(async (_text: string) => {});

  beforeEach(() => {
    onChanged.mockClear();
    onDeleted.mockClear();
    writeText.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    restoreGlobalFetch();
  });

  afterEach(() => cleanup());

  function renderDetail(
    type: "secret" | "key" | "certificate",
    name: string,
    flags: ReadonlySet<ResourceOperation> = FLAGS,
  ) {
    return render(
      <VaultObjectDetail
        connection={connection}
        type={type}
        name={name}
        flags={flags}
        onChanged={onChanged}
        onDeleted={onDeleted}
      />,
    );
  }

  test("a secret shows its metadata and versions with the value masked — nothing about it is shown", async () => {
    const server = installVaultServer();
    renderDetail("secret", "db-password");
    expect(screen.getByText("Reading…")).toBeDefined();
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    expect(screen.getByText("Value hidden")).toBeDefined();
    expect(screen.queryByText(/revealed-value/)).toBeNull();
    expect(server.count("secret/reveal")).toBe(0);
    expect(screen.getByText("text/plain")).toBeDefined();
    expect(screen.getByText("Recoverable")).toBeDefined();
    expect(screen.getAllByTestId("vault-version-row")).toHaveLength(2);
    expect(screen.getByText("No")).toBeDefined();
  });

  test("Reveal calls the reveal route; Hide drops the value; Copy only while revealed", async () => {
    const server = installVaultServer();
    renderDetail("secret", "db-password");
    await waitFor(() => screen.getByRole("button", { name: "Reveal" }));
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => screen.getByText("revealed-value"));
    expect(server.last("secret/reveal")?.body).toMatchObject({ name: "db-password" });

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Copied"));
    expect(writeText).toHaveBeenCalledWith("revealed-value");

    writeText.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Could not copy: denied"));

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("revealed-value")).toBeNull();
    expect(screen.getByText("Value hidden")).toBeDefined();
  });

  test("a refused reveal shows the sentence", async () => {
    installVaultServer({ "secret/reveal": refuse(404, 'secret "db-password" does not exist') });
    renderDetail("secret", "db-password");
    await waitFor(() => screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => screen.getByText('secret "db-password" does not exist'));
  });

  test("Edit opens an EMPTY form; an empty value saves properties only", async () => {
    const server = installVaultServer();
    renderDetail("secret", "db-password");
    await waitFor(() => screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("New value (empty keeps the current value)") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Content type") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "application/json" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2030-01-01T00:00" } });
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "team=a" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const body = server.last("secret/save")?.body;
    expect(body).toMatchObject({
      name: "db-password",
      contentType: "application/json",
      tags: { team: "a" },
      enabled: false,
    });
    expect(body).not.toHaveProperty("value");
    expect(body?.expiresOn).toBe(new Date("2030-01-01T00:00").toISOString());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("vault-secret-form")).toBeNull();
  });

  test("keys show type, size and permitted operations; certificates their subject and thumbprint", async () => {
    installVaultServer();
    renderDetail("key", "signing");
    await waitFor(() => screen.getByText("2048 bits"));
    expect(screen.getByText("sign, verify")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("vault-secret-value")).toBeNull();
    cleanup();
    renderDetail("key", "ec-key");
    await waitFor(() => screen.getByText("P-256"));
    cleanup();
    renderDetail("certificate", "site-cert");
    await waitFor(() => screen.getByText("CN=example.test"));
    expect(screen.getByText("AB01")).toBeDefined();
  });

  test("an object without versions or with unknowns renders dashes", async () => {
    installVaultServer({
      object: () => ({
        json: {
          type: "key",
          name: "bare",
          enabled: null,
          createdOn: null,
          updatedOn: null,
          expiresOn: null,
          notBefore: null,
          tags: {},
          contentType: null,
          keyType: null,
          keySize: null,
          curve: null,
          subject: null,
          issuer: null,
          thumbprint: null,
          version: null,
          recoveryLevel: null,
          keyOperations: [],
          versions: [],
          versionsTruncated: true,
        },
      }),
    });
    renderDetail("key", "bare", new Set(["vault.keys"]) as ReadonlySet<ResourceOperation>);
    await waitFor(() => screen.getByTestId("vault-object-detail"));
    expect(screen.queryByTestId("vault-version-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    cleanup();
    installVaultServer({
      object: () => ({
        json: {
          type: "certificate",
          name: "bare",
          enabled: false,
          tags: {},
          subject: null,
          issuer: null,
          thumbprint: null,
          keyOperations: [],
          versions: [{ version: "c1", enabled: null, createdOn: null, updatedOn: null, expiresOn: null }],
          versionsTruncated: true,
        },
      }),
    });
    renderDetail("certificate", "bare", new Set(["vault.certificates"]) as ReadonlySet<ResourceOperation>);
    await waitFor(() => screen.getByText("Versions (1+)"));
  });

  test("soft delete is one confirm; the vault's refusal is shown", async () => {
    const server = installVaultServer();
    renderDetail("secret", "db-password");
    await waitFor(() => screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/moves to Deleted items/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(server.last("object/delete")?.body).toMatchObject({ type: "secret", name: "db-password" });
    cleanup();

    installVaultServer({ "object/delete": refuse(403, "forbidden by policy") });
    renderDetail("secret", "db-password");
    await waitFor(() => screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => screen.getByText("forbidden by policy"));
  });

  test("without soft delete, delete asks for the typed name and says it is permanent", async () => {
    installVaultServer();
    renderDetail("secret", "db-password", new Set(["vault.secrets", "vault.delete"]) as ReadonlySet<ResourceOperation>);
    await waitFor(() => screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/permanently removes the object and cannot be undone/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Type db-password to confirm"), { target: { value: "db-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  test("a detail that cannot be read says why", async () => {
    installVaultServer({ object: refuse(404, 'key "gone" does not exist') });
    renderDetail("key", "gone");
    await waitFor(() => screen.getByText('key "gone" does not exist'));
  });
});
