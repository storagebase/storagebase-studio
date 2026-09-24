import "../../../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { restoreGlobalFetch } from "../../../helpers/mock-fetch";
import { connection, installVaultServer, refuse } from "./vault-server";

import { SecretForm } from "@/components/resources/vault/SecretForm";
import { KeyCreateForm } from "@/components/resources/vault/KeyCreateForm";
import { CERTIFICATE_MAX_BYTES, CertificateImportForm } from "@/components/resources/vault/CertificateImportForm";
import { formatDate, localToIso, tagsText } from "@/components/resources/vault/vault-api";

const onSaved = mock((_name: string) => {});
const onCancel = mock(() => {});

beforeEach(() => {
  onSaved.mockClear();
  onCancel.mockClear();
  restoreGlobalFetch();
});

afterEach(() => cleanup());

describe("SecretForm", () => {
  test("creates with value and metadata", async () => {
    const server = installVaultServer();
    render(<SecretForm connection={connection} withMetadata onSaved={onSaved} onCancel={onCancel} />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " api-key " } });
    fireEvent.click(save);
    expect(screen.getByText("Enter a value.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "bad" } });
    fireEvent.click(save);
    expect(screen.getByText('Tags: "bad" is not name=value')).toBeDefined();
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("api-key"));
    expect(server.last("secret/save")?.body).toEqual({ connection, name: "api-key", value: "v1", enabled: true });
    expect((screen.getByLabelText("Value") as HTMLTextAreaElement).value).toBe("");
  });

  test("without the metadata flag only a value is saved, and an edit needs one", async () => {
    const server = installVaultServer();
    render(
      <SecretForm
        connection={connection}
        existingName="kv/app"
        withMetadata={false}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByLabelText("Content type")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter a value.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("New value (empty keeps the current value)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("kv/app"));
    expect(server.last("secret/save")?.body).toEqual({ connection, name: "kv/app", value: "x" });
  });

  test("a refused save keeps the form and shows the sentence", async () => {
    installVaultServer({ "secret/save": refuse(404, "secret does not exist") });
    render(<SecretForm connection={connection} existingName="a" withMetadata onSaved={onSaved} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => screen.getByText("secret does not exist"));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("KeyCreateForm", () => {
  test("creates RSA or EC keys with expiry and tags", async () => {
    const server = installVaultServer();
    render(<KeyCreateForm connection={connection} onSaved={onSaved} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "sig" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("sig"));
    expect(server.last("key/create")?.body).toEqual({
      connection,
      name: "sig",
      keyType: "RSA",
      keySize: 2048,
      enabled: true,
    });

    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "EC-P-384" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2031-01-01T00:00" } });
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "a=b" } });
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(server.last("key/create")?.body).toMatchObject({
      keyType: "EC",
      curve: "P-384",
      tags: { a: "b" },
      enabled: false,
    });
  });

  test("bad tags and refusals are shown", async () => {
    installVaultServer({ "key/create": refuse(409, "key is being deleted") });
    render(<KeyCreateForm connection={connection} onSaved={onSaved} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "sig" } });
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "=x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(screen.getByText('Tags: "=x" is not name=value')).toBeDefined();
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => screen.getByText("key is being deleted"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("CertificateImportForm", () => {
  function choose(name: string, contents: string | Uint8Array<ArrayBuffer> = "-----BEGIN CERTIFICATE-----") {
    fireEvent.change(screen.getByLabelText("Certificate file"), { target: { files: [new File([contents], name)] } });
  }

  test("imports PEM and PFX by extension with password and tags; the password is cleared", async () => {
    const server = installVaultServer();
    render(<CertificateImportForm connection={connection} onSaved={onSaved} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "site" } });
    choose("site.crt");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("site"));
    const pem = server.last("certificate/import")?.body;
    expect(pem).toMatchObject({ name: "site", format: "pem" });
    expect(Buffer.from(pem?.contentsBase64 as string, "base64").toString()).toBe("-----BEGIN CERTIFICATE-----");

    choose("bundle.PFX", new Uint8Array([1, 2, 3]));
    fireEvent.change(screen.getByLabelText("Password (PFX/P12, optional)"), { target: { value: "file-password" } });
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "env=test" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(server.last("certificate/import")?.body).toMatchObject({
      format: "pkcs12",
      contentsBase64: "AQID",
      password: "file-password",
      tags: { env: "test" },
    });
    expect((screen.getByLabelText("Password (PFX/P12, optional)") as HTMLInputElement).value).toBe("");
  });

  test("refuses other extensions, oversize files and bad tags before sending; shows refusals", async () => {
    const server = installVaultServer({ "certificate/import": refuse(400, "bad password") });
    render(<CertificateImportForm connection={connection} onSaved={onSaved} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "c" } });
    choose("notes.txt");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => screen.getByText("Choose a .pem, .cer, .crt, .pfx or .p12 file."));
    choose("big.pem", new Uint8Array(CERTIFICATE_MAX_BYTES + 1));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => screen.getByText("Certificate files are at most 1024 KiB."));
    choose("c.p12");
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => screen.getByText('Tags: "x" is not name=value'));
    expect(server.count("certificate/import")).toBe(0);
    fireEvent.change(screen.getByLabelText("Tags (name=value per line)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => screen.getByText("bad password"));
    fireEvent.change(screen.getByLabelText("Certificate file"), { target: { files: [] } });
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("vault-api helpers", () => {
  test("dates, local inputs and tags format for display", () => {
    expect(formatDate("2026-01-02T03:04:05.000Z")).toBe("2026-01-02 03:04:05 UTC");
    expect(formatDate("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04:05 UTC");
    expect(formatDate(null, "Never")).toBe("Never");
    expect(localToIso("")).toBeUndefined();
    expect(localToIso("garbage")).toBeUndefined();
    expect(localToIso("2026-01-01T00:00")).toBe(new Date("2026-01-01T00:00").toISOString());
    expect(tagsText({ a: "1", b: "2" })).toBe("a=1, b=2");
  });

  test("a refusal without a JSON body falls back to the status", async () => {
    const { mockGlobalFetch } = await import("../../../helpers/mock-fetch");
    const { sendJson } = await import("@/components/resources/vault/vault-api");
    mockGlobalFetch({ "api/resources/meta": { status: 503, text: "gateway" } });
    await expect(sendJson("/api/resources/meta", "POST", {})).rejects.toThrow("Request failed (503)");
  });
});
