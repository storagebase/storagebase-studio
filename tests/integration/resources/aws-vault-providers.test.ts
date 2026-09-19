import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * KMS + Secrets Manager provider tests. The SDKs are doubled with
 * mock.module; answers are shaped from live passes against LocalStack
 * (measured 2026-09-20):
 * - KMS describe answers full key metadata (the read surface); creation
 *   answers the new id; re-writing an alias retargets it (rotation) via
 *   UpdateAlias after the expected AlreadyExistsException.
 * - Secrets Manager create-then-update is the upsert; delete uses the
 *   default recovery window.
 */

function fakeCommand(name: string, input: unknown) {
  return { commandName: name, input };
}

class FakeCommand {
  constructor(
    public readonly commandName: string,
    public readonly input: unknown,
  ) {}
}
const cmd = (name: string) =>
  class extends FakeCommand {
    constructor(input: unknown) {
      super(name, input);
    }
  };

const sentCalls: Array<{ command: string; input: unknown }> = [];

interface KmsKey {
  id: string;
  description: string;
  aliases: string[];
}

const kmsKeys: Record<string, KmsKey> = {};
const smSecrets: Record<string, string> = {};

function kmsError(name: string, message: string) {
  const error = new Error(message) as Error & { name: string };
  error.name = name;
  return error;
}

class FakeKMSClient {
  destroy() {}
  async send(command: { commandName: string; input: Record<string, unknown> }): Promise<unknown> {
    sentCalls.push({ command: command.commandName, input: command.input });
    switch (command.commandName) {
      case "ListKeysCommand":
        return { Keys: Object.keys(kmsKeys).map((KeyId) => ({ KeyId })), Truncated: false };
      case "DescribeKeyCommand": {
        const id = command.input.KeyId as string;
        const key = Object.values(kmsKeys).find((k) => k.id === id || k.aliases.includes(id));
        if (!key) throw kmsError("NotFoundException", `Unknown key ${id}`);
        return {
          KeyMetadata: {
            KeyId: key.id,
            Description: key.description,
            KeyState: "Enabled",
            CreationDate: new Date("2026-09-19T23:40:58.404Z"),
          },
        };
      }
      case "CreateKeyCommand": {
        const id = `key-${Object.keys(kmsKeys).length}`;
        kmsKeys[id] = { id, description: (command.input.Description as string) ?? "", aliases: [] };
        return { KeyMetadata: { KeyId: id } };
      }
      case "CreateAliasCommand": {
        const alias = command.input.AliasName as string;
        if (Object.values(kmsKeys).some((k) => k.aliases.includes(alias))) {
          throw kmsError("AlreadyExistsException", `Alias ${alias} exists`);
        }
        kmsKeys[command.input.TargetKeyId as string].aliases.push(alias);
        return {};
      }
      case "UpdateAliasCommand": {
        const alias = command.input.AliasName as string;
        for (const key of Object.values(kmsKeys)) key.aliases = key.aliases.filter((a) => a !== alias);
        kmsKeys[command.input.TargetKeyId as string].aliases.push(alias);
        return {};
      }
      case "ScheduleKeyDeletionCommand": {
        const id = command.input.KeyId as string;
        if (!kmsKeys[id]) throw kmsError("NotFoundException", `Unknown key ${id}`);
        expect(command.input.PendingWindowInDays).toBe(7);
        delete kmsKeys[id];
        return { DeletionDate: new Date() };
      }
      default:
        throw new Error(`unexpected command ${command.commandName}`);
    }
  }
}

class FakeSecretsManagerClient {
  destroy() {}
  async send(command: { commandName: string; input: Record<string, unknown> }): Promise<unknown> {
    sentCalls.push({ command: command.commandName, input: command.input });
    switch (command.commandName) {
      case "ListSecretsCommand":
        return {
          SecretList: Object.keys(smSecrets).map((Name) => ({ Name })),
          NextToken: undefined,
        };
      case "GetSecretValueCommand": {
        const id = command.input.SecretId as string;
        if (!(id in smSecrets)) throw kmsError("ResourceNotFoundException", `Unknown secret ${id}`);
        return { SecretString: smSecrets[id], VersionId: "v1" };
      }
      case "CreateSecretCommand": {
        const name = command.input.Name as string;
        if (name in smSecrets) throw kmsError("ResourceExistsException", `Exists ${name}`);
        smSecrets[name] = command.input.SecretString as string;
        return {};
      }
      case "UpdateSecretCommand": {
        const id = command.input.SecretId as string;
        if (!(id in smSecrets)) throw kmsError("ResourceNotFoundException", `Unknown secret ${id}`);
        smSecrets[id] = command.input.SecretString as string;
        return {};
      }
      case "DeleteSecretCommand": {
        const id = command.input.SecretId as string;
        if (!(id in smSecrets)) throw kmsError("ResourceNotFoundException", `Unknown secret ${id}`);
        expect(command.input.ForceDeleteWithoutRecovery ?? false).toBe(false);
        delete smSecrets[id];
        return {};
      }
      default:
        throw new Error(`unexpected command ${command.commandName}`);
    }
  }
}

mock.module("@aws-sdk/client-kms", () => ({
  KMSClient: FakeKMSClient,
  ListKeysCommand: cmd("ListKeysCommand"),
  DescribeKeyCommand: cmd("DescribeKeyCommand"),
  CreateKeyCommand: cmd("CreateKeyCommand"),
  CreateAliasCommand: cmd("CreateAliasCommand"),
  UpdateAliasCommand: cmd("UpdateAliasCommand"),
  ScheduleKeyDeletionCommand: cmd("ScheduleKeyDeletionCommand"),
}));

mock.module("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: FakeSecretsManagerClient,
  ListSecretsCommand: cmd("ListSecretsCommand"),
  GetSecretValueCommand: cmd("GetSecretValueCommand"),
  CreateSecretCommand: cmd("CreateSecretCommand"),
  UpdateSecretCommand: cmd("UpdateSecretCommand"),
  DeleteSecretCommand: cmd("DeleteSecretCommand"),
}));

const { AwsKmsProvider } = await import("@/lib/resources/providers/vaults/aws-kms");
const { AwsSecretsManagerProvider } = await import("@/lib/resources/providers/vaults/aws-secrets-manager");

const kmsConnection: ResourceConnection = {
  id: "res-1",
  name: "kms",
  type: "aws-kms",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

const smConnection: ResourceConnection = {
  id: "res-2",
  name: "secrets",
  type: "aws-secrets-manager",
  createdAt: "2026-01-01T00:00:00.000Z",
  region: "us-east-1",
};

function seed() {
  for (const key of Object.keys(kmsKeys)) delete kmsKeys[key];
  for (const key of Object.keys(smSecrets)) delete smSecrets[key];
  kmsKeys["k1"] = { id: "k1", description: "anchor key", aliases: ["alias/live"] };
  smSecrets["storagebase/fixture"] = JSON.stringify({ username: "fixture", password: "fixture-pass" });
}

describe("AwsKmsProvider", () => {
  beforeEach(() => {
    seed();
    sentCalls.length = 0;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("aws-kms");
    expect(await createResourceProvider(kmsConnection)).toBeInstanceOf(AwsKmsProvider);
  });

  test("refuses a connection with no region", () => {
    expect(() => new AwsKmsProvider({ ...kmsConnection, region: undefined })).toThrow(ResourceConfigError);
  });

  test("lists keys as roots", async () => {
    const provider = new AwsKmsProvider(kmsConnection);
    const page = await provider.listNodes(null);
    expect(page.nodes).toEqual([{ id: "key/k1", parentId: null, kind: "key", name: "k1", hasChildren: false }]);
  });

  test("reads key metadata as the value — material is never readable", async () => {
    const provider = new AwsKmsProvider(kmsConnection);
    const read = await provider.readSecret("alias/live");
    expect(JSON.parse(read.value)).toMatchObject({ KeyId: "k1", Description: "anchor key" });
    expect(read.metadata?.createdAt).toContain("2026-09-19");
  });

  test("a missing key is a 404", async () => {
    const provider = new AwsKmsProvider(kmsConnection);
    const error = await provider.readSecret("no-such-key").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("writes create keys, alias re-writes rotate", async () => {
    const provider = new AwsKmsProvider(kmsConnection);
    await provider.writeSecret("alias/live", "rotated");
    const rotated = Object.values(kmsKeys).find((key) => key.aliases.includes("alias/live"));
    expect(rotated?.description).toBe("rotated");
    expect(rotated?.id).not.toBe("k1");
  });

  test("deletes schedule 7-day oblivion", async () => {
    const provider = new AwsKmsProvider(kmsConnection);
    await provider.deleteSecret("k1");
    expect("k1" in kmsKeys).toBe(false);

    const error = await provider.deleteSecret("k1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("capabilities declare the mapped vault surface", () => {
    const provider = new AwsKmsProvider(kmsConnection);
    expect(provider.getCapabilities().operations).toEqual(["tree", "secret.read", "secret.write", "secret.delete"]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Keys", itemNoun: "Keys" });
  });
});

describe("AwsSecretsManagerProvider", () => {
  beforeEach(() => {
    seed();
    sentCalls.length = 0;
  });

  test("registers itself and resolves through the factory", async () => {
    expect(registeredResourceTypes()).toContain("aws-secrets-manager");
    expect(await createResourceProvider(smConnection)).toBeInstanceOf(AwsSecretsManagerProvider);
  });

  test("lists secrets as roots", async () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    const page = await provider.listNodes(null);
    expect(page.nodes).toEqual([
      {
        id: "secret/storagebase/fixture",
        parentId: null,
        kind: "secret",
        name: "storagebase/fixture",
        meta: {},
        hasChildren: false,
      },
    ]);
  });

  test("reads string values with versions", async () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    const read = await provider.readSecret("storagebase/fixture");
    expect(JSON.parse(read.value)).toEqual({ username: "fixture", password: "fixture-pass" });
    expect(read.metadata?.version).toBe("v1");
  });

  test("a missing secret is a 404", async () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    const error = await provider.readSecret("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("writes create, then update on exists", async () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    await provider.writeSecret("storagebase/new", JSON.stringify({ a: 1 }));
    expect(smSecrets["storagebase/new"]).toBe(JSON.stringify({ a: 1 }));
    await provider.writeSecret("storagebase/new", JSON.stringify({ a: 2 }));
    expect(smSecrets["storagebase/new"]).toBe(JSON.stringify({ a: 2 }));
  });

  test("deletes without force", async () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    await provider.deleteSecret("storagebase/fixture");
    expect("storagebase/fixture" in smSecrets).toBe(false);
  });

  test("capabilities declare the vault surface", () => {
    const provider = new AwsSecretsManagerProvider(smConnection);
    expect(provider.getCapabilities().operations).toEqual(["tree", "secret.read", "secret.write", "secret.delete"]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Secrets", itemNoun: "Secrets" });
  });
});
