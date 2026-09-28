import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { resetMockSearchParams, setMockSearchParams } from "../../../helpers/mock-navigation";
import { installFetchRouter, type Answer } from "./fetch-router";
import { storage } from "@/lib/storage";

/** Admin > Access > Vault exclusions (StorageBase fork): the global rule list, its editor and the preview. */

const { VaultExclusionsPanel } = await import("@/components/admin/access/VaultExclusionsPanel");
const { AccessAdmin } = await import("@/components/admin/access/AccessAdmin");

const RULE = {
  id: "r1",
  vaultType: "azure-key-vault",
  vaultPattern: "^kv-prod-",
  vaultPatternKind: "regex",
  objectPattern: "break-glass-*",
  objectPatternKind: "glob",
  objectType: "secret",
  enabled: true,
  note: "compliance",
  updatedBy: "admin",
  updatedAt: "2026-09-27T10:00:00.000Z",
};
const ANY_RULE = {
  ...RULE,
  id: "r2",
  vaultType: "any",
  vaultPattern: "*",
  objectType: "any",
  enabled: false,
  note: "",
};

const MANAGED_VAULT = {
  id: "managed:team-kv",
  name: "Team vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  managed: true,
  permission: "admin",
  groupNames: [],
};
const OWN_VAULT = {
  id: "own-bao",
  name: "Own bao",
  type: "openbao",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://bao.test:8200",
  token: "own-token",
};

const PATH = "/api/resources/admin/vault-exclusions";

function routes(extra: Record<string, Answer> = {}) {
  return installFetchRouter({
    [`GET ${PATH}`]: { body: { rules: [RULE, ANY_RULE], storeAvailable: true } },
    "GET /api/resources/managed": {
      body: { connections: [MANAGED_VAULT, { ...MANAGED_VAULT, id: "managed:bucket", type: "s3", name: "Bucket" }] },
    },
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});
afterEach(() => {
  cleanup();
  resetMockSearchParams();
});

describe("VaultExclusionsPanel", () => {
  test("lists every rule with its vault, objects, state, note and stamp", async () => {
    routes();
    const view = render(<VaultExclusionsPanel />);
    await view.findByText("^kv-prod-");
    const rows = view.getAllByTestId("vault-exclusion-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Azure Key Vault")).not.toBeNull();
    expect(within(rows[0]).getByText("Secrets")).not.toBeNull();
    expect(within(rows[0]).getByText("compliance")).not.toBeNull();
    expect(rows[0].textContent).toContain("2026-09-27 10:00:00 UTC");
    expect(within(rows[1]).getByText("Any vault")).not.toBeNull();
    expect((within(rows[1]).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  test("no rules, no server storage, and a failed load each say so", async () => {
    routes({ [`GET ${PATH}`]: { body: { rules: [], storeAvailable: true } } });
    const first = render(<VaultExclusionsPanel />);
    expect(await first.findByText(/No exclusion rules/)).not.toBeNull();
    first.unmount();
    routes({ [`GET ${PATH}`]: { body: { rules: [], storeAvailable: false, message: "Needs storage" } } });
    const second = render(<VaultExclusionsPanel />);
    expect((await second.findByRole("note")).textContent).toBe("Needs storage");
    second.unmount();
    routes({ [`GET ${PATH}`]: { status: 500, body: { error: "boom" } } });
    const third = render(<VaultExclusionsPanel />);
    expect(third.getByText("Loading exclusion rules…")).not.toBeNull();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"));
  });

  test("creates a rule from the form; the server's refusal is shown beside it", async () => {
    let refuse = true;
    const router = routes({
      [`POST ${PATH}`]: () =>
        refuse ? { status: 400, body: { error: 'Rule: "vaultPattern" a repeated group…' } } : { status: 201, body: {} },
    });
    const view = render(<VaultExclusionsPanel />);
    await view.findByText("^kv-prod-");
    fireEvent.change(view.getByLabelText("Vault type"), { target: { value: "hashicorp-vault" } });
    fireEvent.change(view.getByLabelText("Vault pattern"), { target: { value: "(a+)+" } });
    fireEvent.change(view.getByLabelText("Vault pattern kind"), { target: { value: "regex" } });
    fireEvent.change(view.getByLabelText("Object type"), { target: { value: "key" } });
    fireEvent.change(view.getByLabelText("Object pattern"), { target: { value: "signing" } });
    fireEvent.change(view.getByLabelText("Object pattern kind"), { target: { value: "exact" } });
    fireEvent.change(view.getByLabelText("Note"), { target: { value: "why" } });
    fireEvent.click(view.getByLabelText("Enabled"));
    fireEvent.click(view.getByRole("button", { name: "Add rule" }));
    expect((await view.findByRole("alert")).textContent).toContain("repeated group");
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({
      vaultType: "hashicorp-vault",
      vaultPattern: "(a+)+",
      vaultPatternKind: "regex",
      objectPattern: "signing",
      objectPatternKind: "exact",
      objectType: "key",
      enabled: false,
      note: "why",
    });

    refuse = false;
    fireEvent.change(view.getByLabelText("Vault pattern"), { target: { value: "vault-*" } });
    fireEvent.click(view.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Exclusion rule created"));
    expect((view.getByLabelText("Vault pattern") as HTMLInputElement).value).toBe("");
    expect(router.calls.filter((call) => call.method === "GET" && call.path === PATH)).toHaveLength(2);
  });

  test("edits a rule in the form, and cancel puts the form back", async () => {
    const router = routes({ [`PUT ${PATH}`]: { body: {} } });
    const view = render(<VaultExclusionsPanel />);
    await view.findByText("^kv-prod-");
    fireEvent.click(view.getByRole("button", { name: "Edit rule break-glass-* on ^kv-prod-" }));
    expect((view.getByLabelText("Vault pattern") as HTMLInputElement).value).toBe("^kv-prod-");
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect((view.getByLabelText("Vault pattern") as HTMLInputElement).value).toBe("");

    fireEvent.click(view.getByRole("button", { name: "Edit rule break-glass-* on ^kv-prod-" }));
    fireEvent.change(view.getByLabelText("Note"), { target: { value: "changed" } });
    fireEvent.click(view.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Exclusion rule updated"));
    const { updatedBy: _by, updatedAt: _at, ...input } = RULE;
    expect(router.calls.find((call) => call.method === "PUT")?.body).toEqual({ ...input, note: "changed" });
  });

  test("toggles and deletes rules, toasting failures", async () => {
    let fail = false;
    const router = routes({
      [`PUT ${PATH}`]: () => (fail ? { status: 500, body: { error: "put failed" } } : { body: {} }),
      [`DELETE ${PATH}`]: () => (fail ? { status: 500, body: { error: "delete failed" } } : { body: {} }),
    });
    const view = render(<VaultExclusionsPanel />);
    await view.findByText("^kv-prod-");
    const [first, second] = view.getAllByTestId("vault-exclusion-row");
    fireEvent.click(within(first).getByRole("checkbox"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Rule disabled"));
    expect(router.calls.find((call) => call.method === "PUT")?.body).toMatchObject({ id: "r1", enabled: false });
    fireEvent.click(within(second).getByRole("checkbox"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Rule enabled"));

    // Deleting the rule being edited clears the form too.
    fireEvent.click(view.getByRole("button", { name: "Edit rule break-glass-* on ^kv-prod-" }));
    fireEvent.click(view.getByRole("button", { name: "Delete rule break-glass-* on ^kv-prod-" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Exclusion rule deleted"));
    expect(router.calls.find((call) => call.method === "DELETE")?.path).toBe(`${PATH}?id=r1`);
    expect((view.getByLabelText("Vault pattern") as HTMLInputElement).value).toBe("");
    fireEvent.click(view.getByRole("button", { name: "Delete rule break-glass-* on *" }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(4));

    fail = true;
    fireEvent.click(within(first).getByRole("checkbox"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("put failed"));
    fireEvent.click(view.getByRole("button", { name: "Delete rule break-glass-* on ^kv-prod-" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("delete failed"));
  });

  test("previews the saved rules or the form's rule against a managed or an own vault — counts only", async () => {
    storage.saveResourceConnection(OWN_VAULT as never);
    let fail = false;
    const router = routes({
      [`POST ${PATH}/preview`]: () =>
        fail
          ? { status: 502, body: { error: "vault unreachable" } }
          : { body: { applicableRules: 1, counts: { secret: { total: 3, hidden: 1 }, key: { total: 2, hidden: 0 } } } },
    });
    const view = render(<VaultExclusionsPanel />);
    await view.findByText("^kv-prod-");
    fireEvent.click(view.getByRole("button", { name: "Preview saved rules" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Pick a vault connection to preview against"));

    const picker = view.getByLabelText("Vault connection") as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(3));
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      "Select a vault…",
      "Team vault (Azure Key Vault, managed)",
      "Own bao (OpenBao)",
    ]);
    fireEvent.change(picker, { target: { value: "managed:team-kv" } });
    fireEvent.click(view.getByRole("button", { name: "Preview saved rules" }));
    expect((await view.findByTestId("vault-exclusion-preview")).textContent).toContain(
      "Saved rules: 1 rule applies to this vault.",
    );
    expect(view.getByText("Would hide 1 of 3 Secrets")).not.toBeNull();
    expect(view.getByText("Would hide 0 of 2 Keys")).not.toBeNull();
    // A managed vault travels by id only.
    expect(router.calls.at(-1)?.body).toEqual({ connectionId: "managed:team-kv" });

    fireEvent.change(picker, { target: { value: "own-bao" } });
    expect(view.queryByTestId("vault-exclusion-preview")).toBeNull();
    fireEvent.change(view.getByLabelText("Object pattern"), { target: { value: "x-*" } });
    fireEvent.click(view.getByRole("button", { name: "Preview the form's rule" }));
    await view.findByText(/The rule in the form/);
    const body = router.calls.at(-1)?.body as { connection: { id: string }; rules: Array<{ objectPattern: string }> };
    expect(body.connection.id).toBe("own-bao");
    expect(body.rules[0].objectPattern).toBe("x-*");

    fail = true;
    fireEvent.click(view.getByRole("button", { name: "Preview saved rules" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("vault unreachable"));
  });

  test("with no vault connection at all, the preview says so", async () => {
    routes({
      "GET /api/resources/managed": { body: { connections: [] } },
    });
    const view = render(<VaultExclusionsPanel />);
    expect(await view.findByText("No vault connection to preview against.")).not.toBeNull();
  });
});

describe("the Access section opens on a tab named by the link", () => {
  test("?tab=vault-exclusions lands on Vault exclusions", async () => {
    routes();
    setMockSearchParams(new URLSearchParams({ tab: "vault-exclusions" }));
    const view = render(<AccessAdmin />);
    expect(await view.findByText("^kv-prod-")).not.toBeNull();
    expect(view.getByRole("tab", { name: "Vault exclusions" }).getAttribute("data-state")).toBe("active");
  });
});
