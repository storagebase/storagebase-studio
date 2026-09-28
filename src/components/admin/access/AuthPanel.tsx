"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { LogIn, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withBasePath } from "@/lib/config/base-path";
import { LOCAL_LOGIN_POLICIES, type AuthSettings, type LocalLoginPolicy } from "@/lib/access/types";
import type { EntraTestResult } from "@/lib/access/auth-settings";
import { accessRequest, errorText, PANEL_CLASS, useAccessData } from "./api";
import { StoreNotice } from "./StoreNotice";

/**
 * The sign-in switch (StorageBase fork): whether "Sign in with Microsoft" is on and who may still
 * use email/password, with the rails the server enforces spelled out, the Entra configuration the
 * server read from its environment, and the "test sign-in" that has to succeed before Entra can be
 * turned on here.
 */

interface EntraSummary {
  tenantId?: string;
  clientId?: string;
  redirectUri?: string | null;
  adminRoles?: string[];
  allowedRoles?: string[];
  sessionHours?: number;
  error: string | null;
}

interface AuthSettingsResponse {
  settings: AuthSettings;
  entra: EntraSummary | null;
  test: EntraTestResult | null;
  storeAvailable: boolean;
}

const POLICY_TEXT: Record<LocalLoginPolicy, string> = {
  enabled: "Everyone may also sign in with email and password.",
  "admin-only": "Only administrator accounts may use email and password (break-glass).",
  disabled: "Nobody may use email and password. Only allowed while Entra is on.",
};

function EntraConfigSummary({ entra }: { entra: EntraSummary | null }) {
  if (!entra) {
    return (
      <p className="text-sm text-fg-muted">
        Not configured: set STORAGEBASE_ENTRA_TENANT_ID, STORAGEBASE_ENTRA_CLIENT_ID and
        STORAGEBASE_ENTRA_CLIENT_SECRET.
      </p>
    );
  }
  if (entra.error) return <p className="text-sm text-danger">Configuration error: {entra.error}</p>;
  const rows: Array<[string, string]> = [
    ["Tenant", entra.tenantId ?? ""],
    ["Client", entra.clientId ?? ""],
    ["Redirect URI", entra.redirectUri ?? "derived from the request"],
    ["Admin roles", (entra.adminRoles ?? []).join(", ")],
    ["Allowed roles", (entra.allowedRoles ?? []).join(", ") || "any"],
    ["Session", `${entra.sessionHours} h`],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="font-mono text-fg break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TestResult({ test }: { test: EntraTestResult | null }) {
  if (!test) return <p className="text-xs text-fg-muted">No test sign-in yet.</p>;
  const when = `${new Date(test.at).toLocaleString()} by ${test.by}`;
  if (!test.ok) {
    return (
      <output className="block text-xs text-danger">
        Last test failed ({test.error}) — {when}
      </output>
    );
  }
  return (
    <output className="block space-y-1 text-xs">
      <span className="block text-success">Last test succeeded — {when}</span>
      <span className="block text-fg-secondary">
        Signed in as {test.claims?.upn} ({test.claims?.studioRole}); app roles:{" "}
        {test.claims?.roles.length ? test.claims.roles.join(", ") : "none"}
      </span>
    </output>
  );
}

/**
 * The switch's form. Keyed by the saved settings, so a reload that answers new settings starts it
 * afresh from them rather than copying them into state from an effect.
 */
function SwitchForm({
  settings,
  entraUsable,
  storeAvailable,
  onSaved,
}: {
  settings: AuthSettings;
  entraUsable: boolean;
  storeAvailable: boolean;
  onSaved: () => void;
}) {
  const [entraEnabled, setEntraEnabled] = useState(settings.entraEnabled);
  const [localLogin, setLocalLogin] = useState<LocalLoginPolicy>(settings.localLogin);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await accessRequest("/api/admin/access/auth-settings", { method: "POST", body: { entraEnabled, localLogin } });
      toast.success("Sign-in settings saved");
      onSaved();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={PANEL_CLASS} aria-label="Sign-in switch">
      <h3 className="text-sm font-bold text-fg-secondary">Sign-in switch</h3>
      <div className="flex items-center gap-2 text-sm">
        <input
          id="entra-enabled"
          type="checkbox"
          checked={entraEnabled}
          disabled={!entraUsable || !storeAvailable}
          onChange={(e) => setEntraEnabled(e.target.checked)}
        />
        <label htmlFor="entra-enabled">Offer “Sign in with Microsoft”</label>
      </div>
      <fieldset className="space-y-2" disabled={!storeAvailable}>
        <legend className="text-sm font-medium">Email and password sign-in</legend>
        {LOCAL_LOGIN_POLICIES.map((policy) => (
          <div key={policy} className="flex items-start gap-2 text-sm">
            <input
              id={`local-login-${policy}`}
              type="radio"
              name="local-login"
              className="mt-1"
              checked={localLogin === policy}
              onChange={() => setLocalLogin(policy)}
            />
            <label htmlFor={`local-login-${policy}`}>
              <span className="font-medium">{policy}</span>
              <span className="block text-xs text-fg-muted">{POLICY_TEXT[policy]}</span>
            </label>
          </div>
        ))}
      </fieldset>
      <p className="text-xs text-fg-muted">
        Email and password cannot be disabled while Entra is off. Turning Entra on needs a successful test sign-in in
        the last 24 hours.
      </p>
      <p className="text-xs text-fg-muted">
        Now: Entra {settings.entraEnabled ? "on" : "off"}, local sign-in {settings.localLogin} — from the{" "}
        {settings.source === "store" ? `saved setting (${settings.updatedBy}, ${settings.updatedAt})` : "environment"}.
      </p>
      <Button size="sm" onClick={save} disabled={busy || !storeAvailable}>
        <Save className="h-3.5 w-3.5" />
        Save sign-in settings
      </Button>
    </section>
  );
}

export function AuthPanel() {
  const { data, reload } = useAccessData<AuthSettingsResponse>("/api/admin/access/auth-settings");
  const testOutcome = useSearchParams().get("entraTest");

  useEffect(() => {
    if (testOutcome === "ok") toast.success("Test sign-in with Microsoft succeeded");
    else if (testOutcome === "failed") toast.error("Test sign-in with Microsoft failed");
  }, [testOutcome]);

  if (!data) return <p className="text-sm text-fg-muted">Loading sign-in settings…</p>;
  const { settings } = data;
  const entraUsable = data.entra !== null && !data.entra.error;

  return (
    <div className="space-y-6">
      <section className={PANEL_CLASS} aria-label="Microsoft Entra ID">
        <h3 className="text-sm font-bold text-fg-secondary">Microsoft Entra ID</h3>
        <EntraConfigSummary entra={data.entra} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!entraUsable}
            onClick={() => {
              window.location.href = withBasePath("/api/auth/entra/login?test=1");
            }}
          >
            <LogIn className="h-3.5 w-3.5" />
            Test sign-in with Microsoft
          </Button>
          <TestResult test={data.test} />
        </div>
      </section>

      {!data.storeAvailable && (
        <StoreNotice message="The sign-in switch follows the environment (STORAGEBASE_ENTRA_ENABLED, STORAGEBASE_LOCAL_LOGIN); saving it here needs server storage (STORAGE_PROVIDER=sqlite or postgres)." />
      )}

      <SwitchForm
        key={`${settings.entraEnabled}:${settings.localLogin}:${settings.updatedAt ?? ""}`}
        settings={settings}
        entraUsable={entraUsable}
        storeAvailable={data.storeAvailable}
        onSaved={reload}
      />
    </div>
  );
}
