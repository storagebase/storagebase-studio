import "../setup-dom";

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useResourceConnectionForm } from "@/hooks/use-resource-connection-form";
import { registerResourceProviderLoader } from "@/lib/resources/registry";
import type { ResourceConnection } from "@/lib/resources/types";

// =============================================================================
// useResourceConnectionForm Tests
// =============================================================================
describe("useResourceConnectionForm", () => {
  const defaultProps = {
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock(() => {}),
    editConnection: null as ResourceConnection | null,
  };

  beforeEach(() => {
    defaultProps.onClose.mockClear();
    defaultProps.onConnect.mockClear();
    restoreGlobalFetch();
  });

  test("starts with s3 defaults and an empty form", () => {
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    expect(result.current.type).toBe("s3");
    expect(result.current.name).toBe("");
    expect(result.current.environment).toBe("local");
    expect(result.current.fieldValues.endpoint).toBe("");
    expect(result.current.fieldValues.region).toBe("");
    expect(result.current.isTesting).toBe(false);
    expect(result.current.testResult).toBeNull();
    expect(result.current.isEditMode).toBe(false);
  });

  test("fieldsForType follows the selected type's config", () => {
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    expect([...result.current.fieldsForType]).toEqual([
      "region",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "endpoint",
    ]);
    expect(result.current.takesField("token")).toBe(false);

    act(() => {
      result.current.setType("kafka");
    });

    expect([...result.current.fieldsForType]).toEqual(["endpoint"]);
    expect(result.current.takesField("endpoint")).toBe(true);
    expect(result.current.takesField("region")).toBe(false);
  });

  test("selectableTypes is empty until a provider loader registers", () => {
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    expect(result.current.selectableTypes()).toEqual([]);
    expect(result.current.selectableTypes("blob")).toEqual([]);

    act(() => {
      registerResourceProviderLoader("s3", async () => {
        throw new Error("never loaded by the form");
      });
      registerResourceProviderLoader("kafka", async () => {
        throw new Error("never loaded by the form");
      });
    });

    expect([...result.current.selectableTypes()]).toEqual(["s3", "kafka"]);
    expect([...result.current.selectableTypes("blob")]).toEqual(["s3"]);
    expect([...result.current.selectableTypes("messaging")]).toEqual(["kafka"]);
    expect(result.current.selectableTypes("vault")).toEqual([]);
  });

  test("test button posts the built connection and shows success with latency", async () => {
    const fetchMock = mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: false, message: "Connected", latencyMs: 42 } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    act(() => {
      result.current.setName("backups");
      result.current.setFieldValue("region", "us-east-1");
      result.current.setFieldValue("accessKeyId", "AKID");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as ResourceConnection;
    expect(body.type).toBe("s3");
    expect(body.name).toBe("backups");
    expect(body.region).toBe("us-east-1");
    expect(body.accessKeyId).toBe("AKID");
    // Empty fields write nothing, and fields the type does not take are dropped.
    expect(body).not.toHaveProperty("endpoint");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("secretAccessKey");

    expect(result.current.testResult?.tone).toBe("success");
    expect(result.current.testResult?.message).toBe("Connected successfully (42ms)");
    expect(result.current.isTesting).toBe(false);
  });

  test("test button shows the server sentence on failure", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: false, degraded: false, message: "socket refused" } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult?.tone).toBe("error");
    expect(result.current.testResult?.message).toBe("socket refused");
    expect(defaultProps.onConnect).not.toHaveBeenCalled();
  });

  test("test button shows a warning when the service answers no health data", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: true, message: "Connected, custom health broken" } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult?.tone).toBe("warning");
    expect(result.current.testResult?.message).toBe("Connected, custom health broken");
  });

  test("test button reports a network error when fetch throws", async () => {
    mockGlobalFetch({
      "api/resources/test": () => {
        throw new Error("down");
      },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult?.tone).toBe("error");
    expect(result.current.testResult?.message).toBe("Network error - could not reach server");
  });

  test("connect saves on success and stamps id, default name, environment color", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: false, message: "Connected", latencyMs: 7 } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    act(() => {
      result.current.setType("kafka");
      result.current.setFieldValue("endpoint", "broker:9092");
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(defaultProps.onConnect).toHaveBeenCalledTimes(1);
    const saved = defaultProps.onConnect.mock.calls[0][0] as ResourceConnection;
    expect(saved.id).toBeDefined();
    expect(saved.name).toBe("kafka-connection");
    expect(saved.type).toBe("kafka");
    expect(saved.endpoint).toBe("broker:9092");
    expect(saved.environment).toBe("local");
    expect(saved.color).toBeDefined();
    expect(typeof saved.createdAt).toBe("string");
    // The form clears for the next connection.
    expect(result.current.name).toBe("");
    expect(result.current.fieldValues.endpoint).toBe("");
  });

  test("connect refuses to save when the probe fails", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: false, degraded: false, message: "bad token" } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(defaultProps.onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult?.tone).toBe("error");
  });

  test("degraded save needs a second click", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: true, message: "no health surface" } },
    });
    const { result } = renderHook(() => useResourceConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleConnect();
    });
    expect(defaultProps.onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult?.tone).toBe("warning");
    expect(result.current.testResult?.message).toContain("again to save it anyway");

    await act(async () => {
      await result.current.handleConnect();
    });
    expect(defaultProps.onConnect).toHaveBeenCalledTimes(1);
  });

  test("uses the adapter instead of fetch when provided", async () => {
    const onTestConnection = mock(async () => ({ success: true, message: "via adapter", latencyMs: 3 }));
    const fetchMock = mockGlobalFetch({
      "api/resources/test": { json: { success: false, message: "must not reach here" } },
    });
    const { result } = renderHook(() => useResourceConnectionForm({ ...defaultProps, onTestConnection }));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.testResult?.tone).toBe("success");
  });

  test("edit mode populates the form and preserves group and tunnel", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: false, message: "Connected" } },
    });
    const editConnection: ResourceConnection = {
      id: "res-1",
      name: "vault",
      type: "hashicorp-vault",
      createdAt: "2026-01-01T00:00:00.000Z",
      environment: "production",
      endpoint: "https://vault:8200",
      token: "s coupled",
      group: "team-a",
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
    };
    const { result } = renderHook(() => useResourceConnectionForm({ ...defaultProps, editConnection }));

    expect(result.current.isEditMode).toBe(true);
    expect(result.current.name).toBe("vault");
    expect(result.current.type).toBe("hashicorp-vault");
    expect(result.current.environment).toBe("production");
    expect(result.current.fieldValues.endpoint).toBe("https://vault:8200");

    await act(async () => {
      await result.current.handleConnect();
    });

    const saved = defaultProps.onConnect.mock.calls[0][0] as ResourceConnection;
    expect(saved.id).toBe("res-1");
    expect(saved.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(saved.group).toBe("team-a");
    expect(saved.sshTunnel?.host).toBe("bastion");
  });

  test("closing the dialog clears secrets so the next new connection starts empty", () => {
    const editConnection: ResourceConnection = {
      id: "res-1",
      name: "vault",
      type: "hashicorp-vault",
      createdAt: "2026-01-01T00:00:00.000Z",
      token: "s3cret",
    };
    const { result, rerender } = renderHook(
      ({ isOpen, editConnection: edit }: { isOpen: boolean; editConnection: ResourceConnection | null }) =>
        useResourceConnectionForm({ ...defaultProps, isOpen, editConnection: edit }),
      { initialProps: { isOpen: true, editConnection } },
    );

    expect(result.current.fieldValues.token).toBe("s3cret");

    rerender({ isOpen: false, editConnection: null });

    expect(result.current.name).toBe("");
    expect(result.current.type).toBe("s3");
    expect(result.current.fieldValues.token).toBe("");
    expect(result.current.fieldValues.endpoint).toBe("");
  });
});
