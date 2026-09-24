import { describe, test, expect, mock } from "bun:test";
import { ResourceNotFoundError, ResourceOperationUnsupportedError } from "@/lib/resources/errors";
import {
  BASIC_VAULT_LEVEL_LIMIT,
  BASIC_VAULT_LIST_LIMIT,
  BasicVaultWorkbench,
  vaultPathOf,
  vaultTypeOf,
} from "@/lib/resources/providers/vaults/basic-workbench";
import type { ResourceNode, ResourceNodePage } from "@/lib/resources/types";

function leaf(id: string, kind = "secret", meta?: ResourceNode["meta"]): ResourceNode {
  return { id, parentId: null, kind, name: id, hasChildren: false, ...(meta ? { meta } : {}) };
}

function folder(id: string): ResourceNode {
  return { id, parentId: null, kind: "folder", name: id, hasChildren: true };
}

function providerOver(levels: Record<string, ResourceNodePage>) {
  return {
    listNodes: mock(async (parent: string | null) => levels[parent ?? "<root>"] ?? { nodes: [], truncated: false }),
    listMounts: mock(async () => ({ nodes: [], truncated: false })),
    listSecrets: mock(async () => ({ nodes: [], truncated: false })),
    readSecret: mock(async (path: string) => ({ name: path, value: "v", metadata: { version: "3", createdAt: null } })),
    writeSecret: mock(async () => undefined),
    deleteSecret: mock(async () => undefined),
  };
}

describe("BasicVaultWorkbench", () => {
  test("addresses leaves by path and types KMS leaves as keys", () => {
    expect(vaultPathOf(leaf("mount/kv/app/db"))).toBe("kv/app/db");
    expect(vaultPathOf(leaf("secret/name"))).toBe("name");
    expect(vaultPathOf(leaf("key/abc", "key"))).toBe("abc");
    expect(vaultTypeOf(leaf("key/abc", "key"))).toBe("key");
    expect(vaultTypeOf(leaf("secret/a"))).toBe("secret");
  });

  test("flattens the tree breadth-first into one listing of the requested type", async () => {
    const provider = providerOver({
      "<root>": { nodes: [folder("mount/kv"), leaf("key/k1", "key")], truncated: false },
      "mount/kv": {
        nodes: [
          leaf("mount/kv/a", "secret", { enabled: true, modified: "2026-01-01T00:00:00.000Z" }),
          folder("mount/kv/app/"),
        ],
        truncated: false,
      },
      "mount/kv/app/": { nodes: [leaf("mount/kv/app/db")], truncated: true },
    });
    const workbench = new BasicVaultWorkbench(provider);
    const secrets = await workbench.listVaultObjects("secret");
    expect(secrets.objects.map((object) => object.name)).toEqual(["kv/a", "kv/app/db"]);
    expect(secrets.objects[0]).toMatchObject({ enabled: true, updatedOn: "2026-01-01T00:00:00.000Z" });
    expect(secrets.objects[1]).toMatchObject({ enabled: null, updatedOn: null });
    expect(secrets.truncated).toBe(true);
    expect((await workbench.listVaultObjects("key")).objects.map((object) => object.name)).toEqual(["k1"]);
  });

  test("stops at the object bound and at the level bound", async () => {
    const many = {
      "<root>": {
        nodes: Array.from({ length: BASIC_VAULT_LIST_LIMIT + 5 }, (_, index) => leaf(`secret/s${index}`)),
        truncated: false,
      },
    };
    const byCount = await new BasicVaultWorkbench(providerOver(many)).listVaultObjects("secret");
    expect(byCount).toMatchObject({ truncated: true });
    expect(byCount.objects).toHaveLength(BASIC_VAULT_LIST_LIMIT);

    const deep = {
      "<root>": {
        nodes: Array.from({ length: BASIC_VAULT_LEVEL_LIMIT + 1 }, (_, index) => folder(`mount/m${index}`)),
        truncated: false,
      },
    };
    expect((await new BasicVaultWorkbench(providerOver(deep)).listVaultObjects("secret")).truncated).toBe(true);
  });

  test("detail comes from the listing, never from readSecret", async () => {
    const provider = providerOver({ "<root>": { nodes: [leaf("secret/a")], truncated: false } });
    const workbench = new BasicVaultWorkbench(provider);
    expect(await workbench.describeVaultObject("secret", "a")).toMatchObject({
      name: "a",
      versions: [],
      version: null,
    });
    expect(provider.readSecret).not.toHaveBeenCalled();
    expect(await workbench.describeVaultObject("secret", "b").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test("reveal, save and delete go through the generic operations; the rest refuse", async () => {
    const provider = providerOver({});
    const workbench = new BasicVaultWorkbench(provider);
    expect(await workbench.revealSecret("kv/a")).toEqual({ name: "kv/a", value: "v", version: "3" });
    provider.readSecret.mockResolvedValueOnce({ name: "x", value: "w", metadata: null } as never);
    expect((await workbench.revealSecret("x")).version).toBeNull();
    await workbench.saveSecret("kv/a", { value: "new" });
    expect(provider.writeSecret).toHaveBeenCalledWith("kv/a", "new");
    await workbench.deleteVaultObject("secret", "kv/a");
    expect(provider.deleteSecret).toHaveBeenCalledWith("kv/a");
    for (const refusal of [
      workbench.saveSecret("kv/a", { enabled: false }),
      workbench.createKey(),
      workbench.importCertificate(),
      workbench.listDeletedVaultObjects(),
      workbench.recoverDeletedVaultObject(),
      workbench.purgeDeletedVaultObject(),
    ]) {
      expect(await refusal.catch((e: unknown) => e)).toBeInstanceOf(ResourceOperationUnsupportedError);
    }
  });
});
