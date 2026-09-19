import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CONNECTION_FIELDS,
  SECRET_FIELD_MAPS,
  decryptResourceConnections,
  encryptResourceConnections,
} from "@/lib/storage/connection-secrets";
import type { ResourceConnection } from "@/lib/resources/types";

const connection = (overrides: Partial<ResourceConnection> = {}): ResourceConnection => ({
  id: "res-1",
  name: "Test",
  type: "s3",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("resource connection credential classification", () => {
  test("every ResourceConnection field is classified — the compile-time map, measured at runtime", () => {
    const sample: ResourceConnection = {
      id: "x",
      name: "y",
      type: "kafka",
      createdAt: "now",
      color: "red",
      environment: "prod",
      group: "g",
      endpoint: "e",
      region: "r",
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
      connectionString: "c",
      token: "k",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      vaultName: "v",
      namespace: "n",
      sshTunnel: {
        enabled: true,
        host: "bastion",
        port: 22,
        username: "u",
        authMethod: "password",
        password: "p",
      },
    };
    expect(Object.keys(sample).sort()).toEqual(Object.keys(RESOURCE_CONNECTION_FIELDS).sort());
  });

  test("the map is registered in SECRET_FIELD_MAPS — the reflective guard the docblock promises", () => {
    expect(SECRET_FIELD_MAPS).toContain(RESOURCE_CONNECTION_FIELDS);
  });

  test("cloud and vault credentials seal; identifiers and endpoints stay plaintext", () => {
    const sealed = encryptResourceConnections([
      connection({ secretAccessKey: "shh", token: "tok", endpoint: "https://vault:8200", region: "us-east-1" }),
    ])[0];
    expect(sealed.secretAccessKey).not.toBe("shh");
    expect(sealed.token).not.toBe("tok");
    expect(sealed.endpoint).toBe("https://vault:8200");
    expect(sealed.region).toBe("us-east-1");
  });

  test("a bastion password inside sshTunnel seals with the same rules", () => {
    const sealed = encryptResourceConnections([
      connection({
        sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password", password: "pw" },
      }),
    ])[0];
    expect(sealed.sshTunnel?.password).not.toBe("pw");
    expect(sealed.sshTunnel?.host).toBe("b");
  });

  test("empty strings are skipped and a round trip restores every sealed field", () => {
    const original = connection({
      secretAccessKey: "shh",
      token: "",
      sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password", password: "pw" },
    });
    const sealed = encryptResourceConnections([original])[0];
    expect(sealed.token).toBe("");
    const { resourceConnections, undecryptable } = decryptResourceConnections([sealed]);
    expect(undecryptable).toBe(0);
    expect(resourceConnections[0].secretAccessKey).toBe("shh");
    expect(resourceConnections[0].sshTunnel?.password).toBe("pw");
  });

  test("an undecryptable envelope is omitted and counted, never thrown", () => {
    const { resourceConnections, undecryptable } = decryptResourceConnections([
      connection({ token: "v0:not-an-envelope" }),
    ]);
    expect(undecryptable).toBe(1);
    expect(resourceConnections[0].token).toBeUndefined();
    // The record survives: a dead credential is an empty field, not a deleted connection.
    expect(resourceConnections[0].id).toBe("res-1");
  });
});
