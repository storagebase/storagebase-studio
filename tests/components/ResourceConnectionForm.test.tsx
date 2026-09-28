import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

// ── Mock framer-motion before component imports ─────────────────────────────
mock.module("framer-motion", () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);

  return {
    motion: new Proxy(
      {},
      {
        get: () => passthrough,
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

// ── Mock useIsMobile — always the Dialog (desktop) path ─────────────────────
mock.module("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

// ── Mock Radix Dialog ───────────────────────────────────────────────────────
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", { "data-testid": "dialog" }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dialog-content" }, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DialogClose: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

import { ResourceConnectionForm } from "@/components/resources/ResourceConnectionForm";
import { registerResourceProviderLoader } from "@/lib/resources/registry";
import type { ResourceConnection } from "@/lib/resources/types";

// NOTE: the provider registry is module state, so loader registration persists
// across tests in this file. The empty-state tests run first, registration
// after — do not reorder without moving the empty-state tests to their own file.

describe("ResourceConnectionForm", () => {
  const formProps = {
    category: "blob" as const,
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock((_conn: ResourceConnection) => {}),
    editConnection: null as ResourceConnection | null,
  };

  beforeEach(() => {
    formProps.onClose.mockClear();
    formProps.onConnect.mockClear();
    restoreGlobalFetch();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows an empty state when no provider module is registered", () => {
    render(<ResourceConnectionForm {...formProps} />);

    expect(screen.getByText("No Blob Storage providers yet")).toBeDefined();
    expect(screen.queryByLabelText("Connection Name")).toBeNull();
  });

  test("picker lists registered types and fields follow the selected type", () => {
    registerResourceProviderLoader("s3", async () => {
      throw new Error("never loaded by the form");
    });

    render(<ResourceConnectionForm {...formProps} />);

    expect(screen.getByText("Amazon S3")).toBeDefined();
    // s3 fields per RESOURCE_UI_CONFIG.
    expect(screen.getByLabelText("Region")).toBeDefined();
    expect(screen.getByLabelText("Access Key ID")).toBeDefined();
    expect(screen.getByLabelText("Secret Access Key")).toBeDefined();
    // Secret fields are password inputs.
    expect(screen.getByLabelText("Secret Access Key").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Access Key ID").getAttribute("type")).not.toBe("password");
  });

  test("switching types swaps the field list", () => {
    registerResourceProviderLoader("azure-blob", async () => {
      throw new Error("never loaded by the form");
    });

    render(<ResourceConnectionForm {...formProps} />);

    expect(screen.getByLabelText("Region")).toBeDefined();
    fireEvent.click(screen.getByText("Azure Blob Storage"));

    expect(screen.queryByLabelText("Region")).toBeNull();
    expect(screen.getByLabelText("Endpoint")).toBeDefined();
    expect(screen.getByLabelText("Client Secret")).toBeDefined();
  });

  test("degraded and failed probes render warning and error tones", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: true, message: "no health surface" } },
    });
    render(<ResourceConnectionForm {...formProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => {
      expect(screen.getByTestId("resource-connection-test-result").getAttribute("data-tone")).toBe("warning");
    });

    mockGlobalFetch({
      "api/resources/test": { json: { success: false, degraded: false, message: "refused" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => {
      const banner = screen.getByTestId("resource-connection-test-result");
      expect(banner.getAttribute("data-tone")).toBe("error");
      expect(within(banner).getByText("refused")).toBeDefined();
    });
  });

  test("kafka shows only its endpoint field", () => {
    registerResourceProviderLoader("kafka", async () => {
      throw new Error("never loaded by the form");
    });

    render(<ResourceConnectionForm {...formProps} category="messaging" />);

    expect(screen.getByText("Apache Kafka")).toBeDefined();
    expect(screen.queryByText("Amazon S3")).toBeNull();
    expect(screen.getByLabelText("Endpoint")).toBeDefined();
    expect(screen.queryByLabelText("Region")).toBeNull();
  });

  test("test and save flow posts to the resource test route", async () => {
    mockGlobalFetch({
      "api/resources/test": { json: { success: true, degraded: false, message: "Connected", latencyMs: 11 } },
    });
    render(<ResourceConnectionForm {...formProps} />);

    fireEvent.change(screen.getByLabelText("Connection Name"), { target: { value: "backups" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "us-east-1" } });

    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() => {
      const banner = screen.getByTestId("resource-connection-test-result");
      expect(banner.getAttribute("data-tone")).toBe("success");
      expect(within(banner).getByText("Connected successfully (11ms)")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Establish Connection" }));

    await waitFor(() => {
      expect(formProps.onConnect).toHaveBeenCalledTimes(1);
    });
    const saved = formProps.onConnect.mock.calls[0][0] as ResourceConnection;
    expect(saved.name).toBe("backups");
    expect(saved.type).toBe("s3");
    expect(saved.region).toBe("us-east-1");
  });
});
