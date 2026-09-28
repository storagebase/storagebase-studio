// @requires helm
/**
 * The Deployment's update strategy.
 *
 * A RollingUpdate starts the new pod before it stops the old one. When /app/data is a
 * ReadWriteOnce claim, the volume attaches to one node at a time, so a new pod the scheduler
 * places on another node waits in ContainerCreating on a Multi-Attach error for a volume the old
 * pod never releases - the old pod is only stopped once the new one is Ready - and the rollout
 * hangs until its progress deadline. So a single pod on a ReadWriteOnce (or ReadWriteOncePod)
 * volume defaults to Recreate, everything else keeps the Kubernetes default by rendering no
 * field at all, and an explicit `strategy` value always wins.
 *
 * Exercised against real `helm template` output, like the sibling chart tests.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_DIR = join(import.meta.dir, "../../charts/storagebase-studio");
const RELEASE = "release-under-test";

/** Above one replica the zero-config bootstrap refuses to render without a shared JWT secret. */
const SHARED_JWT = ["--set", "secrets.jwtSecret=not-a-secret-helm-template-fixture-value"];

const RECREATE = { type: "Recreate", rollingUpdate: null };

interface RenderedDeployment {
  kind: string;
  spec: { strategy?: Record<string, unknown> };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function strategy(args: string[] = []): Record<string, unknown> | undefined {
  const run = template(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as RenderedDeployment);
  const deployment = docs.find((doc) => doc?.kind === "Deployment");
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return deployment.spec.strategy;
}

describe("charts/storagebase-studio Deployment strategy", () => {
  describe("defaults to Recreate for a single pod on a ReadWriteOnce data volume", () => {
    test("persistence.enabled with the default ReadWriteOnce access mode", () => {
      expect(strategy(["--set", "persistence.enabled=true"])).toEqual(RECREATE);
    });

    test("storageProvider=sqlite, which turns persistence on by itself", () => {
      expect(strategy(["--set", "config.storageProvider=sqlite"])).toEqual(RECREATE);
    });

    test("ReadWriteOncePod, which blocks a second pod even on the same node", () => {
      expect(
        strategy(["--set", "persistence.enabled=true", "--set", "persistence.accessModes={ReadWriteOncePod}"]),
      ).toEqual(RECREATE);
    });

    test("an existingClaim, read through persistence.accessModes", () => {
      expect(strategy(["--set", "persistence.enabled=true", "--set", "persistence.existingClaim=studio-data"])).toEqual(
        RECREATE,
      );
    });

    test("an HPA whose ceiling is one pod", () => {
      expect(
        strategy([
          ...SHARED_JWT,
          "--set",
          "persistence.enabled=true",
          "--set",
          "autoscaling.enabled=true",
          "--set",
          "autoscaling.minReplicas=1",
          "--set",
          "autoscaling.maxReplicas=1",
        ]),
      ).toEqual(RECREATE);
    });
  });

  describe("omits the field, keeping the Kubernetes default, otherwise", () => {
    test("a default install, whose /app/data is an emptyDir", () => {
      expect(strategy()).toBeUndefined();
    });

    test("a ReadWriteMany volume, which the new pod can mount beside the old one", () => {
      expect(
        strategy(["--set", "persistence.enabled=true", "--set", "persistence.accessModes={ReadWriteMany}"]),
      ).toBeUndefined();
    });

    test("more than one replica, where Recreate would take every pod down at once", () => {
      expect(strategy([...SHARED_JWT, "--set", "persistence.enabled=true", "--set", "replicaCount=2"])).toBeUndefined();
    });

    test("an HPA that can scale past one pod", () => {
      expect(
        strategy([...SHARED_JWT, "--set", "persistence.enabled=true", "--set", "autoscaling.enabled=true"]),
      ).toBeUndefined();
    });
  });

  describe("an explicit strategy always wins", () => {
    test("RollingUpdate on a ReadWriteOnce volume is rendered verbatim, not replaced by Recreate", () => {
      expect(
        strategy([
          "--set",
          "persistence.enabled=true",
          "--set",
          "strategy.type=RollingUpdate",
          "--set",
          "strategy.rollingUpdate.maxSurge=0",
          "--set",
          "strategy.rollingUpdate.maxUnavailable=1",
        ]),
      ).toEqual({ type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } });
    });

    test("Recreate is rendered where the chart would have chosen nothing", () => {
      expect(strategy(["--set", "strategy.type=Recreate"])).toEqual({ type: "Recreate" });
    });

    test("values.schema.json refuses a strategy type Kubernetes does not have", () => {
      const run = template(["--set", "strategy.type=BlueGreen"]);

      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("strategy");
    });
  });
});
