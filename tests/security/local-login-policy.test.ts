import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { NextRequest } from "next/server";
import { installAuthMock } from "../helpers/auth-mock";

/**
 * Threat: the break-glass policy for email/password sign-in (StorageBase fork) becoming an oracle
 * or a bypass. `admin-only` must refuse a non-admin account with the SAME answer as a wrong
 * password, so it reveals neither which accounts exist nor which password was right; `disabled`
 * refuses every attempt before the body is even read.
 */

const login = mock(async (..._args: unknown[]) => {});
installAuthMock({ login });

const { POST } = await import("@/app/api/auth/login/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");

const NAMES = [
  "STORAGEBASE_LOCAL_LOGIN",
  "STORAGEBASE_ENTRA_ENABLED",
  "STORAGEBASE_ENTRA_TENANT_ID",
  "STORAGEBASE_ENTRA_CLIENT_ID",
  "STORAGEBASE_ENTRA_CLIENT_SECRET",
];
const saved: Record<string, string | undefined> = {};

function attempt(email: string, password: string): Promise<Response> {
  return POST(
    new NextRequest("http://studio.test/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  clearRateLimitState();
  login.mockClear();
});
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the local-login policy at POST /api/auth/login", () => {
  test("admin-only: a non-admin's right password answers exactly like a wrong one", async () => {
    process.env.STORAGEBASE_LOCAL_LOGIN = "admin-only";
    const rightPassword = await attempt(process.env.USER_EMAIL as string, process.env.USER_PASSWORD as string);
    const wrongPassword = await attempt(process.env.USER_EMAIL as string, "wrong-password");
    expect(rightPassword.status).toBe(401);
    expect(await rightPassword.json()).toEqual(await wrongPassword.json());
    expect(login).not.toHaveBeenCalled();
  });

  test("admin-only: an administrator still signs in", async () => {
    process.env.STORAGEBASE_LOCAL_LOGIN = "admin-only";
    const res = await attempt(process.env.ADMIN_EMAIL as string, process.env.ADMIN_PASSWORD as string);
    expect(res.status).toBe(200);
    expect(login).toHaveBeenCalledWith("admin", process.env.ADMIN_EMAIL);
  });

  test("disabled (with Entra on): every attempt is refused with 403, the right password included", async () => {
    process.env.STORAGEBASE_ENTRA_TENANT_ID = "00000000-0000-4000-8000-000000000000";
    process.env.STORAGEBASE_ENTRA_CLIENT_ID = "client";
    process.env.STORAGEBASE_ENTRA_CLIENT_SECRET = "secret";
    process.env.STORAGEBASE_ENTRA_ENABLED = "true";
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    const res = await attempt(process.env.ADMIN_EMAIL as string, process.env.ADMIN_PASSWORD as string);
    expect(res.status).toBe(403);
    expect(login).not.toHaveBeenCalled();
  });

  test("disabled while Entra is off reads as admin-only, so nobody is locked out", async () => {
    process.env.STORAGEBASE_LOCAL_LOGIN = "disabled";
    expect((await attempt(process.env.ADMIN_EMAIL as string, process.env.ADMIN_PASSWORD as string)).status).toBe(200);
    expect((await attempt(process.env.USER_EMAIL as string, process.env.USER_PASSWORD as string)).status).toBe(401);
  });
});
