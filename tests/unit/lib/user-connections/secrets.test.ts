import { describe, expect, test } from "bun:test";
import {
  carriesSecrets,
  extractSecrets,
  familySecretPaths,
  readPath,
  targetFingerprint,
  withSecrets,
} from "@/lib/user-connections/secrets";

/**
 * The split between what the browser may keep and what only the server holds (StorageBase fork).
 */

const DB = {
  id: "c1",
  name: "orders",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  user: "app",
  password: "pw-1",
  ssl: { mode: "require", clientKey: "KEY", caCert: "CA" },
  sshTunnel: { enabled: true, host: "bastion", port: 22, username: "ops", password: "", privateKey: "PK" },
  savedSecrets: ["stale"],
  custom: "kept",
};

describe("extractSecrets", () => {
  test("strips every classified secret, nested ones too, and the server-written list", () => {
    const { stripped, secrets } = extractSecrets("database", DB);
    expect(secrets).toEqual({ password: "pw-1", "ssl.clientKey": "KEY", "sshTunnel.privateKey": "PK" });
    expect(stripped).not.toHaveProperty("password");
    expect(stripped).not.toHaveProperty("savedSecrets");
    expect(stripped.ssl).toEqual({ mode: "require", caCert: "CA" });
    expect(stripped.sshTunnel).toEqual({ enabled: true, host: "bastion", port: 22, username: "ops" });
    // Nothing but secrets is removed: the user's own fields survive.
    expect(stripped.custom).toBe("kept");
    // The input is untouched.
    expect(DB.password).toBe("pw-1");
  });

  test("resource rows split by the resource classification", () => {
    const { stripped, secrets } = extractSecrets("resource", {
      id: "r1",
      type: "s3",
      accessKeyId: "AKIA",
      secretAccessKey: "SAK",
      sessionToken: "",
    });
    expect(secrets).toEqual({ secretAccessKey: "SAK" });
    expect(stripped).toEqual({ id: "r1", type: "s3", accessKeyId: "AKIA" });
  });

  test("carriesSecrets answers whether any secret value remains", () => {
    expect(carriesSecrets("database", DB)).toBe(true);
    expect(carriesSecrets("database", extractSecrets("database", DB).stripped)).toBe(false);
  });

  test("the path list covers the nested groups", () => {
    expect(familySecretPaths("database")).toEqual(
      expect.arrayContaining(["password", "ssl.clientKey", "sshTunnel.passphrase", "agentPassword"]),
    );
    expect(familySecretPaths("resource")).toEqual(expect.arrayContaining(["token", "sshTunnel.password"]));
  });
});

describe("targetFingerprint", () => {
  const base = extractSecrets("database", DB).stripped;

  test("is stable, ignores presentation and credentials, and changes with the target", () => {
    expect(targetFingerprint("database", base)).toBe(targetFingerprint("database", { ...base, name: "renamed" }));
    expect(targetFingerprint("database", base)).toBe(targetFingerprint("database", { ...base, password: "x" }));
    expect(targetFingerprint("database", base)).not.toBe(targetFingerprint("database", { ...base, host: "evil" }));
    expect(targetFingerprint("database", base)).not.toBe(
      targetFingerprint("database", { ...base, ssl: { mode: "disable" } }),
    );
    expect(targetFingerprint("database", base)).not.toBe(
      targetFingerprint("database", { ...base, sshTunnel: { ...(base.sshTunnel as object), host: "other" } }),
    );
    expect(targetFingerprint("resource", { type: "s3", endpoint: "a" })).not.toBe(
      targetFingerprint("resource", { type: "s3", endpoint: "b" }),
    );
  });
});

describe("withSecrets and readPath", () => {
  test("writes secrets back, only into containers that exist", () => {
    const row = withSecrets(
      { id: "c1", ssl: { mode: "require" } },
      { password: "pw", "ssl.clientKey": "K", "sshTunnel.password": "lost" },
    );
    expect(row).toEqual({ id: "c1", password: "pw", ssl: { mode: "require", clientKey: "K" } });
    expect(readPath(row, "ssl.clientKey")).toBe("K");
    expect(readPath(row, "sshTunnel.password")).toBeUndefined();
    expect(readPath(row, "password")).toBe("pw");
  });

  test("extractSecrets leaves a non-object container alone", () => {
    const { stripped } = extractSecrets("database", { id: "c", ssl: "broken" });
    expect(stripped.ssl).toBe("broken");
  });
});
