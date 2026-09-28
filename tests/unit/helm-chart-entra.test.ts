// @requires helm
/**
 * Microsoft Entra ID sign-in in the chart (StorageBase fork): `storagebase.entra.*` and
 * `storagebase.localLogin`.
 *
 * Three properties matter, and each case below pins one of them:
 *
 * - **Unset writes nothing.** The app has its own default for every one of these variables, and
 *   the admin-role default (StorageBase.Admin) in particular must stay the app's: a chart that
 *   wrote a role value nobody chose would grant admin on the chart's say-so.
 * - **The client secret travels as a Secret.** It goes into the chart's Secret (or is referenced
 *   from `secrets.existingSecret`) and never into the ConfigMap or the Deployment, where anyone
 *   with `get configmaps` / `get deployments` could read it.
 * - **The schema refuses what the app would refuse**, so a mistake fails at install time rather
 *   than as a sign-in that quietly stays off.
 *
 * Exercised against real `helm template` output, like the sibling chart tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/storagebase-studio");
const RELEASE = "release-under-test";
const SECRET_NAME = `${RELEASE}-storagebase-studio`;

/** Placeholders only: no real tenant, client or role value belongs in this repository. */
const TENANT_ID = "00000000-0000-0000-0000-000000000000";
const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_SECRET = "not-a-secret-entra-fixture-value";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

interface RenderedManifest {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  spec?: { template: { spec: { containers: Array<{ env?: EnvVar[] }> } } };
}

interface Rendered {
  configMap: Record<string, string>;
  secret?: RenderedManifest;
  deployment: RenderedManifest;
  env: EnvVar[];
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function render(args: string[] = []): Rendered {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as RenderedManifest);
  const configMap = docs.find((doc) => doc?.kind === "ConfigMap" && doc.metadata.name.endsWith("-config"));
  const secret = docs.find((doc) => doc?.kind === "Secret" && doc.metadata.name === SECRET_NAME);
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!configMap) throw new Error("no ConfigMap manifest found in rendered chart output");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return {
    configMap: configMap.data ?? {},
    secret,
    deployment,
    env: deployment.spec?.template.spec.containers[0].env ?? [],
  };
}

function envVar(env: EnvVar[], name: string): EnvVar | undefined {
  return env.find((entry) => entry.name === name);
}

function storagebaseKeys(data: Record<string, string>): string[] {
  return Object.keys(data).filter((key) => key.startsWith("STORAGEBASE_"));
}

const CONFIGURED = [
  "--set",
  `storagebase.entra.tenantId=${TENANT_ID}`,
  "--set",
  `storagebase.entra.clientId=${CLIENT_ID}`,
  "--set",
  `storagebase.entra.clientSecret=${CLIENT_SECRET}`,
];

describe("charts/storagebase-studio Microsoft Entra ID sign-in", () => {
  test("a default install renders nothing Entra-related", () => {
    const { configMap, secret, env } = render();

    expect(storagebaseKeys(configMap)).toEqual([]);
    expect(Object.keys(secret?.data ?? {})).not.toContain("entra-client-secret");
    expect(env.filter((entry) => entry.name.startsWith("STORAGEBASE_"))).toEqual([]);
  });

  test("tolerates the whole storagebase block being removed from the values", () => {
    const { configMap, env } = render(["--set", "storagebase=null"]);

    expect(storagebaseKeys(configMap)).toEqual([]);
    expect(envVar(env, "STORAGEBASE_ENTRA_CLIENT_SECRET")).toBeUndefined();
  });

  describe("each non-secret value lands in the ConfigMap only when set", () => {
    const CASES: Array<{ value: string; key: string; set: string; expected: string }> = [
      { value: "tenantId", key: "STORAGEBASE_ENTRA_TENANT_ID", set: TENANT_ID, expected: TENANT_ID },
      { value: "clientId", key: "STORAGEBASE_ENTRA_CLIENT_ID", set: CLIENT_ID, expected: CLIENT_ID },
      {
        value: "adminRoles",
        key: "STORAGEBASE_ENTRA_ADMIN_ROLES",
        set: "StorageBase.Admin\\,Example.Operator",
        expected: "StorageBase.Admin,Example.Operator",
      },
      {
        value: "allowedRoles",
        key: "STORAGEBASE_ENTRA_ALLOWED_ROLES",
        set: "Example.Reader",
        expected: "Example.Reader",
      },
      {
        value: "redirectUri",
        key: "STORAGEBASE_ENTRA_REDIRECT_URI",
        set: "https://studio.example.com/api/auth/entra/callback",
        expected: "https://studio.example.com/api/auth/entra/callback",
      },
      { value: "sessionHours", key: "STORAGEBASE_ENTRA_SESSION_HOURS", set: "12", expected: "12" },
    ];

    for (const { value, key, set, expected } of CASES) {
      test(`storagebase.entra.${value} writes ${key}, and nothing else`, () => {
        const { configMap } = render(["--set", `storagebase.entra.${value}=${set}`]);

        expect(configMap[key]).toBe(expected);
        expect(storagebaseKeys(configMap)).toEqual([key]);
      });
    }

    test("storagebase.localLogin writes STORAGEBASE_LOCAL_LOGIN", () => {
      const { configMap } = render(["--set", "storagebase.localLogin=admin-only"]);

      expect(configMap.STORAGEBASE_LOCAL_LOGIN).toBe("admin-only");
      expect(storagebaseKeys(configMap)).toEqual(["STORAGEBASE_LOCAL_LOGIN"]);
    });
  });

  test("enabled=true writes the switch as a quoted string; false writes nothing, which the app reads the same", () => {
    expect(render(["--set", "storagebase.entra.enabled=true"]).configMap.STORAGEBASE_ENTRA_ENABLED).toBe("true");
    expect(render(["--set", "storagebase.entra.enabled=false"]).configMap).not.toHaveProperty(
      "STORAGEBASE_ENTRA_ENABLED",
    );
  });

  test("a fully configured install still writes no admin role, leaving the app's default in charge", () => {
    const { configMap } = render([...CONFIGURED, "--set", "storagebase.entra.enabled=true"]);

    expect(configMap).not.toHaveProperty("STORAGEBASE_ENTRA_ADMIN_ROLES");
    expect(configMap).not.toHaveProperty("STORAGEBASE_ENTRA_ALLOWED_ROLES");
    expect(configMap).not.toHaveProperty("STORAGEBASE_ENTRA_SESSION_HOURS");
  });

  describe("the client secret", () => {
    test("goes into the chart's Secret and is referenced from the pod, optional", () => {
      const { secret, env } = render(CONFIGURED);

      expect(secret?.data?.["entra-client-secret"]).toBe(Buffer.from(CLIENT_SECRET).toString("base64"));

      const rendered = envVar(env, "STORAGEBASE_ENTRA_CLIENT_SECRET");
      expect(rendered?.valueFrom?.secretKeyRef).toEqual({
        name: SECRET_NAME,
        key: "entra-client-secret",
        optional: true,
      });
      expect(rendered?.value).toBeUndefined();
    });

    test("never appears in the ConfigMap or anywhere in the Deployment", () => {
      const { configMap, deployment } = render(CONFIGURED);

      expect(configMap).not.toHaveProperty("STORAGEBASE_ENTRA_CLIENT_SECRET");
      expect(Object.values(configMap)).not.toContain(CLIENT_SECRET);
      // The decisive assertion: the literal is nowhere in the pod spec, in any field.
      expect(JSON.stringify(deployment)).not.toContain(CLIENT_SECRET);
    });

    test("is referenced from an existingSecret under the default key, and the chart renders no Secret", () => {
      const { secret, env } = render(["--set", "secrets.existingSecret=byo-auth"]);

      expect(secret).toBeUndefined();
      expect(envVar(env, "STORAGEBASE_ENTRA_CLIENT_SECRET")?.valueFrom?.secretKeyRef).toEqual({
        name: "byo-auth",
        key: "entra-client-secret",
        // Optional is what lets an existingSecret that predates Entra keep working untouched.
        optional: true,
      });
    });

    test("an existingSecret wins over an inline value, which is then ignored like every other secret", () => {
      const { secret, env, deployment } = render([...CONFIGURED, "--set", "secrets.existingSecret=byo-auth"]);

      expect(secret).toBeUndefined();
      expect(envVar(env, "STORAGEBASE_ENTRA_CLIENT_SECRET")?.valueFrom?.secretKeyRef?.name).toBe("byo-auth");
      expect(JSON.stringify(deployment)).not.toContain(CLIENT_SECRET);
    });

    test("follows secrets.existingSecretKeys.entraClientSecret in both the Secret and the ref", () => {
      const custom = ["--set", "secrets.existingSecretKeys.entraClientSecret=azure-client-secret"];

      const inline = render([...CONFIGURED, ...custom]);
      expect(Object.keys(inline.secret?.data ?? {})).toContain("azure-client-secret");
      expect(Object.keys(inline.secret?.data ?? {})).not.toContain("entra-client-secret");
      expect(envVar(inline.env, "STORAGEBASE_ENTRA_CLIENT_SECRET")?.valueFrom?.secretKeyRef?.key).toBe(
        "azure-client-secret",
      );

      const external = render(["--set", "secrets.existingSecret=byo-auth", ...custom]);
      expect(envVar(external.env, "STORAGEBASE_ENTRA_CLIENT_SECRET")?.valueFrom?.secretKeyRef).toMatchObject({
        name: "byo-auth",
        key: "azure-client-secret",
      });
    });
  });

  describe("values.schema.json refuses what the app would refuse", () => {
    const REFUSED: Array<{ set: string; path: string }> = [
      { set: "storagebase.localLogin=off", path: "localLogin" },
      { set: "storagebase.localLogin=Admin-Only", path: "localLogin" },
      { set: "storagebase.entra.sessionHours=0", path: "sessionHours" },
      { set: "storagebase.entra.sessionHours=169", path: "sessionHours" },
      { set: "storagebase.entra.tenantId=example.onmicrosoft.com", path: "tenantId" },
      { set: "storagebase.entra.redirectUri=studio.example.com/api/auth/entra/callback", path: "redirectUri" },
    ];

    for (const { set, path } of REFUSED) {
      test(`refuses ${set}`, () => {
        const run = template(["--set", set]);

        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain(path);
      });
    }

    test("refuses a sessionHours that is not an integer", () => {
      const run = template(["--set-string", "storagebase.entra.sessionHours=8"]);

      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("sessionHours");
    });

    for (const policy of ["enabled", "admin-only", "disabled"]) {
      test(`accepts localLogin=${policy}`, () => {
        expect(template(["--set", `storagebase.localLogin=${policy}`]).exitCode).toBe(0);
      });
    }

    test("accepts the boundary session lengths", () => {
      expect(template(["--set", "storagebase.entra.sessionHours=1"]).exitCode).toBe(0);
      expect(template(["--set", "storagebase.entra.sessionHours=168"]).exitCode).toBe(0);
    });
  });
});
