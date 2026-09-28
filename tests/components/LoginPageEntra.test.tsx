import "../setup-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { resetMockSearchParams, setMockSearchParams } from "../helpers/mock-navigation";

/**
 * The login page with the sign-in switch (StorageBase fork): which methods render for each
 * combination the server can answer, and the fixed sentences for the Entra error codes.
 */

const { default: LoginForm } = await import("@/app/login/login-form");
const { entraErrorMessage } = await import("@/components/login/entra-sign-in");

const PROVIDERS = { entra: true, local: true, localAdminOnly: false, oidc: false };

describe("LoginPage (Entra)", () => {
  afterEach(() => {
    cleanup();
    resetMockSearchParams();
  });

  test("Entra on with local sign-in enabled: the Microsoft button above the email form", () => {
    const { getByText, container } = render(<LoginForm authProvider="local" providers={PROVIDERS} />);
    expect(getByText("Sign in with Microsoft")).not.toBeNull();
    expect(getByText("or sign in with email")).not.toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });

  test("admin-only local sign-in is introduced as the administrator path", () => {
    const { getByText } = render(<LoginForm authProvider="local" providers={{ ...PROVIDERS, localAdminOnly: true }} />);
    expect(getByText("Administrator sign-in")).not.toBeNull();
  });

  test("local sign-in disabled: the Microsoft button alone, no form, no divider", () => {
    const { getByText, queryByText, container } = render(
      <LoginForm authProvider="local" providers={{ ...PROVIDERS, local: false }} />,
    );
    expect(getByText("Sign in with Microsoft")).not.toBeNull();
    expect(queryByText("or sign in with email")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  test("Entra off: the email form alone", () => {
    const { queryByText, container } = render(
      <LoginForm authProvider="local" providers={{ ...PROVIDERS, entra: false }} />,
    );
    expect(queryByText("Sign in with Microsoft")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });

  test("the button starts the Entra flow and shows it is redirecting", () => {
    const { getByText } = render(<LoginForm authProvider="local" providers={PROVIDERS} />);
    const saved = window.location.href;
    fireEvent.click(getByText("Sign in with Microsoft"));
    expect(window.location.href).toContain("/api/auth/entra/login");
    expect(getByText("Redirecting...")).not.toBeNull();
    window.location.href = saved;
  });

  test("an error code from the flow renders its fixed sentence, never the raw code", () => {
    setMockSearchParams(new URLSearchParams({ error: "entra_role_not_allowed" }));
    const { getByRole } = render(<LoginForm authProvider="local" providers={PROVIDERS} />);
    expect(getByRole("alert").textContent).toBe(entraErrorMessage("entra_role_not_allowed"));
  });

  test("every Entra and engine code has its own sentence, and anything else the generic one", () => {
    const codes = [
      "entra_disabled",
      "entra_tenant_mismatch",
      "entra_role_not_allowed",
      "oidc_config",
      "oidc_discovery",
    ];
    const sentences = new Set(codes.map(entraErrorMessage));
    expect(sentences.size).toBe(codes.length);
    expect(entraErrorMessage("constructor")).toBe("Authentication failed. Please try again.");
    expect(sentences.has(entraErrorMessage("oidc_failed"))).toBe(false);
  });
});
