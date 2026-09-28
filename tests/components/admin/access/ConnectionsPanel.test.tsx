import "../../../setup-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockToastError, mockToastSuccess } from "../../../helpers/mock-sonner";
import { installFetchRouter } from "./fetch-router";

/**
 * The managed-connections tab (StorageBase fork): listing, the create/edit form built from the
 * product's own field lists, write-only secrets ("leave blank to keep", "Clear" sends null), test
 * connection, and delete.
 */

const { ConnectionsPanel } = await import("@/components/admin/access/ConnectionsPanel");
const { fieldsFor, typeLabel, typeOptions } = await import("@/components/admin/access/connection-fields");

const GROUPS = [
  { id: "payments", name: "Payments", connectionCount: 1, bindingCount: 1 },
  { id: "ops", name: "Ops", connectionCount: 0, bindingCount: 0 },
];

const ROW = {
  id: "orders-db",
  kind: "database",
  type: "postgres",
  name: "Orders",
  clientId: "seed:m_orders-db",
  groupIds: ["payments"],
  groupNames: ["Payments"],
  config: { host: "db.internal", port: 5432, user: "reader", database: "orders", environment: "production" },
  secretsSet: ["password"],
  createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: "admin",
  updatedAt: "2026-09-02T00:00:00.000Z",
  updatedBy: "admin",
};

function routes(extra: Record<string, unknown> = {}) {
  return installFetchRouter({
    "GET /api/admin/access/connections": { body: { connections: [ROW], storeAvailable: true } },
    "GET /api/admin/access/groups": { body: { groups: GROUPS, storeAvailable: true } },
    ...(extra as Record<string, { status?: number; body?: unknown }>),
  });
}

beforeEach(() => {
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
});
afterEach(() => cleanup());

describe("connection fields", () => {
  test("follow each type's own field list, mark credentials, and know nothing of unknown types", () => {
    expect(fieldsFor("database", "postgres").map((field) => field.key)).toEqual([
      "host",
      "port",
      "user",
      "password",
      "database",
    ]);
    expect(fieldsFor("database", "postgres").find((field) => field.key === "password")?.secret).toBe(true);
    expect(fieldsFor("database", "postgres").find((field) => field.key === "port")?.numeric).toBe(true);
    expect(fieldsFor("resource", "s3").some((field) => field.key === "secretAccessKey" && field.secret)).toBe(true);
    expect(fieldsFor("database", "unknown")).toEqual([]);
    expect(fieldsFor("resource", "unknown")).toEqual([]);
    expect(typeOptions("resource")[0].value).toBe("s3");
    expect(typeLabel("database", "postgres")).toBe("PostgreSQL");
    expect(typeLabel("resource", "unknown")).toBe("unknown");
  });
});

describe("ConnectionsPanel", () => {
  test("lists managed connections with type, groups and who changed them last", async () => {
    installFetchRouter({
      "GET /api/admin/access/connections": {
        body: {
          connections: [ROW, { ...ROW, id: "x", name: "Loose", groupIds: [], groupNames: [] }],
          storeAvailable: true,
        },
      },
      "GET /api/admin/access/groups": { body: { groups: GROUPS, storeAvailable: true } },
    });
    const { findByText, getByText, getAllByText } = render(<ConnectionsPanel />);
    expect(await findByText("Orders")).not.toBeNull();
    expect(getAllByText("PostgreSQL")).toHaveLength(2);
    expect(getByText(/Payments · updated/)).not.toBeNull();
    expect(getByText(/No group \(administrators only\)/)).not.toBeNull();
  });

  test("empty, no-storage and failed loads", async () => {
    installFetchRouter({
      "GET /api/admin/access/connections": { body: { connections: [], storeAvailable: true } },
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
    });
    const empty = render(<ConnectionsPanel />);
    expect(await empty.findByText("No managed connections yet.")).not.toBeNull();
    cleanup();

    installFetchRouter({
      "GET /api/admin/access/connections": {
        body: { connections: [], storeAvailable: false, message: "Needs storage" },
      },
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: false } },
    });
    const none = render(<ConnectionsPanel />);
    expect((await none.findByRole("note")).textContent).toBe("Needs storage");
    cleanup();

    installFetchRouter({ "GET /api/admin/access/connections": { status: 403, body: { error: "Unauthorized" } } });
    render(<ConnectionsPanel />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Unauthorized"));
  });

  test("creates a database connection: typed fields, numeric port, groups, optional id", async () => {
    const router = routes({ "POST /api/admin/access/connections": { status: 201, body: { connection: ROW } } });
    const { findByText, getByLabelText, getByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    expect(getByText("TLS and SSH tunnel settings are not editable here yet.")).not.toBeNull();
    fireEvent.change(getByLabelText("Id (optional)"), { target: { value: " orders-db " } });
    fireEvent.change(getByLabelText("Name"), { target: { value: "Orders" } });
    fireEvent.change(getByLabelText("Host"), { target: { value: "db.internal" } });
    fireEvent.change(getByLabelText("Port"), { target: { value: "5432" } });
    fireEvent.change(getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.change(getByLabelText("Environment"), { target: { value: "staging" } });
    fireEvent.change(getByLabelText("Colour"), { target: { value: " #10B981 " } });
    fireEvent.click(getByLabelText("Payments"));
    fireEvent.click(getByLabelText("Ops"));
    fireEvent.click(getByLabelText("Ops"));
    fireEvent.click(getByText("Create connection"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Connection created"));
    expect(router.calls.find((call) => call.method === "POST")?.body).toEqual({
      id: "orders-db",
      kind: "database",
      type: "postgres",
      name: "Orders",
      config: { host: "db.internal", port: 5432, password: "s3cret", environment: "staging", color: "#10B981" },
      groupIds: ["payments"],
    });
  });

  test("a resource connection: switching kind resets the type and the fields", async () => {
    const router = routes({ "POST /api/admin/access/connections": { status: 201, body: { connection: ROW } } });
    const { findByText, getByLabelText, getByText, queryByLabelText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    fireEvent.change(getByLabelText("Host"), { target: { value: "stale" } });
    fireEvent.click(getByLabelText("Resource"));
    expect(queryByLabelText("Host")).toBeNull();
    fireEvent.change(getByLabelText("Type"), { target: { value: "azure-key-vault" } });
    fireEvent.change(getByLabelText("Name"), { target: { value: "Team vault" } });
    fireEvent.change(getByLabelText("Vault name"), { target: { value: "team-vault" } });
    fireEvent.click(getByText("Create connection"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(router.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      kind: "resource",
      type: "azure-key-vault",
      config: { vaultName: "team-vault" },
      groupIds: [],
    });
  });

  test("a nameless connection is refused before any request", async () => {
    const router = routes();
    const { findByText, getByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    fireEvent.click(getByText("Create connection"));
    expect(mockToastError).toHaveBeenCalledWith("A connection needs a name");
    expect(router.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("edits: a stored secret says so, blank keeps it, Clear sends null, kind and type are fixed", async () => {
    const router = routes({ "PUT /api/admin/access/connections": { body: { connection: ROW } } });
    const { findByLabelText, getByLabelText, getByText, queryByLabelText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByLabelText("Edit Orders"));
    expect(getByText("seed:m_orders-db")).not.toBeNull();
    expect(queryByLabelText("Id (optional)")).toBeNull();
    expect((getByLabelText("Type") as HTMLSelectElement).disabled).toBe(true);
    const password = getByLabelText("Password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toBe("Set — leave blank to keep");
    expect((getByLabelText("Host") as HTMLInputElement).value).toBe("db.internal");

    fireEvent.click(getByText("Save connection"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Connection updated"));
    expect(router.calls.find((call) => call.method === "PUT")?.body).toEqual({
      id: "orders-db",
      name: "Orders",
      config: { host: "db.internal", port: 5432, user: "reader", database: "orders", environment: "production" },
      groupIds: ["payments"],
    });

    fireEvent.click(await findByLabelText("Edit Orders"));
    fireEvent.click(getByLabelText("Clear Password"));
    expect((getByLabelText("Password") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(getByText("Save connection"));
    await waitFor(() => expect(router.calls.filter((call) => call.method === "PUT")).toHaveLength(2));
    expect((router.calls.filter((call) => call.method === "PUT")[1].body as { config: unknown }).config).toMatchObject({
      password: null,
    });
  });

  test("a clear can be undone before saving", async () => {
    routes();
    const { findByLabelText, getByLabelText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByLabelText("Edit Orders"));
    fireEvent.click(getByLabelText("Clear Password"));
    fireEvent.click(getByLabelText("Clear Password"));
    expect((getByLabelText("Password") as HTMLInputElement).disabled).toBe(false);
  });

  test("test connection shows the outcome, with the stored record's id when editing", async () => {
    const router = routes({
      "POST /api/admin/access/connections/test": { body: { success: true, message: "Connected", latencyMs: 12 } },
    });
    const { findByLabelText, getByText, findByRole } = render(<ConnectionsPanel />);
    fireEvent.click(await findByLabelText("Edit Orders"));
    fireEvent.click(getByText("Test connection"));
    expect((await findByRole("status")).textContent).toBe("Connected in 12 ms: Connected");
    expect(router.calls.find((call) => call.path === "/api/admin/access/connections/test")?.body).toMatchObject({
      id: "orders-db",
      kind: "database",
      type: "postgres",
    });
  });

  test("a degraded, a failed and a refused test", async () => {
    let answer: { status?: number; body?: unknown } = {
      body: { success: true, degraded: true, message: "Connected, but the health check failed" },
    };
    routes({ "POST /api/admin/access/connections/test": () => answer });
    const { findByText, getByText, findByRole, getByLabelText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    fireEvent.change(getByLabelText("Type"), { target: { value: "mysql" } });
    fireEvent.click(getByText("Test connection"));
    expect((await findByRole("status")).className).toContain("text-warning");

    answer = { body: { success: false, message: "refused" } };
    fireEvent.click(getByText("Test connection"));
    await waitFor(() => expect(getByText("Failed: refused")).not.toBeNull());

    answer = { status: 400, body: { error: "kind: must be database or resource" } };
    fireEvent.click(getByText("Test connection"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("kind: must be database or resource"));
  });

  test("a refused save toasts the server's sentence; cancel closes the form", async () => {
    routes({ "POST /api/admin/access/connections": { status: 409, body: { error: "already exists" } } });
    const { findByText, getByLabelText, getByText, queryByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Orders" } });
    fireEvent.click(getByText("Create connection"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("already exists"));
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Create connection")).toBeNull();
  });

  test("with no groups the form says only administrators can use it", async () => {
    installFetchRouter({
      "GET /api/admin/access/connections": { body: { connections: [], storeAvailable: true } },
      "GET /api/admin/access/groups": { body: { groups: [], storeAvailable: true } },
    });
    const { findByText, getByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByText("New managed connection"));
    expect(getByText(/only administrators can use it/)).not.toBeNull();
  });

  test("delete asks first, can be kept, and deletes on confirm", async () => {
    const router = routes({ "DELETE /api/admin/access/connections": { body: { deleted: "orders-db" } } });
    const { findByLabelText, getByText, queryByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByLabelText("Delete Orders"));
    fireEvent.click(getByText("Keep"));
    expect(queryByText("Confirm delete")).toBeNull();
    fireEvent.click(await findByLabelText("Delete Orders"));
    fireEvent.click(getByText("Confirm delete"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Connection deleted"));
    expect(router.calls.find((call) => call.method === "DELETE")?.path).toBe(
      "/api/admin/access/connections?id=orders-db",
    );
  });

  test("a refused delete toasts", async () => {
    routes({ "DELETE /api/admin/access/connections": { status: 404, body: { error: "not found" } } });
    const { findByLabelText, getByText } = render(<ConnectionsPanel />);
    fireEvent.click(await findByLabelText("Delete Orders"));
    fireEvent.click(getByText("Confirm delete"));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("not found"));
  });
});
