import { describe, test, expect } from "bun:test";
import {
  BASIC_VAULT_LEVEL_LIMIT,
  BASIC_VAULT_LIST_LIMIT,
  BasicVaultWorkbench,
  vaultPathOf,
  vaultTypeOf,
} from "@/storagebase/resources/providers/vaults/basic-workbench";
import { ResourceNotFoundError, ResourceOperationUnsupportedError } from "@/storagebase/resources/errors";
import type { ResourceNode, ResourceNodePage } from "@/storagebase/resources/types";
import type {
  SecretRead,
  VaultOperations,
  VaultWorkbenchOperations as VaultWorkbenchOperationsInterface,
} from "@/storagebase/resources/operations";

/**
 * The generic vault workbench over a provider that only speaks
 * `VaultOperations` — the surface HashiCorp Vault / OpenBao (phase 6) resolve
 * to, and the fallback `resolveVaultWorkbench` answers for any vault
 * provider without a workbench API of its own.
 */

function node(id: string, extra: Partial<ResourceNode> = {}): ResourceNode {
  return { id, parentId: null, kind: id.startsWith("key/") ? "key" : "secret", name: id, hasChildren: false, ...extra };
}

function makeProvider(
  pages: Record<string, ResourceNodePage>,
  reads: Record<string, { value: string; metadata: SecretRead["metadata"] }> = {},
): VaultOperations & { listNodes(parentId: string | null): Promise<ResourceNodePage> } {
  return {
    listNodes: async (parentId) => pages[parentId ?? ""] ?? { nodes: [], truncated: false },
    listMounts: async () => pages[""] ?? { nodes: [], truncated: false },
    listSecrets: async () => ({ nodes: [], truncated: false }),
    readSecret: async (path) => {
      const read = reads[path];
      if (read === undefined) throw new Error(`no read for "${path}"`);
      return { name: path, value: read.value, metadata: read.metadata };
    },
    writeSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
}

describe("vaultPathOf / vaultTypeOf", () => {
  test("the by-name address is the id without its scheme prefix", () => {
    expect(vaultPathOf(node("secret/db/password"))).toBe("db/password");
    expect(vaultPathOf(node("mount/kv/api-key"))).toBe("kv/api-key");
    expect(vaultPathOf(node("key/signing"))).toBe("signing");
  });

  test("a key-kind leaf belongs to the Keys tab, everything else to Secrets", () => {
    expect(vaultTypeOf(node("key/signing"))).toBe("key");
    expect(vaultTypeOf(node("secret/db/password"))).toBe("secret");
    expect(vaultTypeOf({ ...node("x"), kind: "mount" })).toBe("secret");
  });
});

describe("BasicVaultWorkbench", () => {
  test("flattens the tree into one list of paths, bounded and flagged", async () => {
    const provider = makeProvider({
      "": {
        nodes: [
          node("mount/kv", { kind: "mount", hasChildren: true }),
          node("secret/db-password", { meta: { enabled: true } }),
        ],
        truncated: false,
      },
      "mount/kv": {
        nodes: [node("mount/kv/api-token", { meta: { modified: "2026-02-01T00:00:00.000Z" } })],
        truncated: false,
      },
    });
    const workbench = new BasicVaultWorkbench(provider);

    const listing = await workbench.listVaultObjects("secret");
    expect(listing.objects.map((object) => object.name)).toEqual(["db-password", "kv/api-token"]);
    expect(listing.truncated).toBe(false);
    expect(listing.objects[0]).toMatchObject({ enabled: true, updatedOn: null });
    expect(listing.objects[1]).toMatchObject({ enabled: null, updatedOn: "2026-02-01T00:00:00.000Z" });
    expect((await workbench.listVaultObjects("key")).objects).toHaveLength(0);
  });

  test("a level bound or a list bound is reported as truncated, and the page's own flag is kept", async () => {
    const wide: ResourceNodePage = {
      nodes: Array.from({ length: BASIC_VAULT_LIST_LIMIT + 1 }, (_, index) => node(`secret/s-${index}`)),
      truncated: false,
    };
    expect((await new BasicVaultWorkbench(makeProvider({ "": wide })).listVaultObjects("secret")).truncated).toBe(true);

    const pagedTruncated: ResourceNodePage = { nodes: [node("secret/a")], truncated: true };
    expect(
      (await new BasicVaultWorkbench(makeProvider({ "": pagedTruncated })).listVaultObjects("secret")).truncated,
    ).toBe(true);

    let levels = 0;
    const deep: VaultOperations & { listNodes(parentId: string | null): Promise<ResourceNodePage> } = {
      ...makeProvider({}),
      listNodes: async () => {
        levels += 1;
        return {
          nodes: [
            node(`secret/leaf-${levels}`, { meta: {} }),
            node(`folder-${levels}`, { kind: "folder", hasChildren: true }),
          ],
          truncated: false,
        };
      },
    };
    const levelled = await new BasicVaultWorkbench(deep).listVaultObjects("secret");
    expect(levelled.truncated).toBe(true);
    expect(levels).toBe(BASIC_VAULT_LEVEL_LIMIT);
  });

  test("describe answers from the flattened listing, a miss as a 404", async () => {
    const workbench = new BasicVaultWorkbench(
      makeProvider({ "": { nodes: [node("secret/api-key", { meta: { enabled: false } })], truncated: false } }),
    );
    const found = await workbench.describeVaultObject("secret", "api-key");
    expect(found).toMatchObject({
      name: "api-key",
      enabled: false,
      version: null,
      recoveryLevel: null,
      keyOperations: [],
      versions: [],
      versionsTruncated: false,
    });
    expect(await workbench.describeVaultObject("secret", "nope").catch((e: unknown) => e)).toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test("reveal reads through readSecret, keeping its version", async () => {
    const workbench = new BasicVaultWorkbench(
      makeProvider({}, { "api-key": { value: "s3cret", metadata: { version: "v9", createdAt: null } } }),
    );
    expect(await workbench.revealSecret("api-key")).toEqual({ name: "api-key", value: "s3cret", version: "v9" });
  });

  test("a save without a value refuses: these vaults have no properties to update", async () => {
    const workbench = new BasicVaultWorkbench(makeProvider({}));
    expect(await workbench.saveSecret("a", { enabled: true }).catch((e: unknown) => e)).toBeInstanceOf(
      ResourceOperationUnsupportedError,
    );
  });

  test("every capability the generic surface lacks refuses with its honest sentence", async () => {
    // Typed as the interface the routes resolve to: the refusal methods take
    // the arguments the workbench would pass, and ignore them.
    const workbench: VaultWorkbenchOperationsInterface = new BasicVaultWorkbench(makeProvider({}));
    await expect(workbench.createKey("k", { keyType: "EC", curve: "P-256" })).rejects.toBeInstanceOf(
      ResourceOperationUnsupportedError,
    );
    await expect(workbench.importCertificate("c", { contentsBase64: "AA==", format: "pem" })).rejects.toBeInstanceOf(
      ResourceOperationUnsupportedError,
    );
    await expect(workbench.listDeletedVaultObjects("secret")).rejects.toBeInstanceOf(ResourceOperationUnsupportedError);
    await expect(workbench.recoverDeletedVaultObject("secret", "a")).rejects.toBeInstanceOf(
      ResourceOperationUnsupportedError,
    );
    await expect(workbench.purgeDeletedVaultObject("secret", "a")).rejects.toBeInstanceOf(
      ResourceOperationUnsupportedError,
    );
  });

  test("delete and a value save pass through to the provider", async () => {
    const calls: string[] = [];
    const provider = makeProvider({});
    const tracked: VaultOperations & { listNodes(parentId: string | null): Promise<ResourceNodePage> } = {
      ...provider,
      writeSecret: async (path, value) => {
        calls.push(`write:${path}=${value}`);
      },
      deleteSecret: async (path) => {
        calls.push(`delete:${path}`);
      },
    };
    const workbench = new BasicVaultWorkbench(tracked);
    await workbench.saveSecret("api-key", { value: "v1" });
    await workbench.deleteVaultObject("key", "signing");
    expect(calls).toEqual(["write:api-key=v1", "delete:signing"]);
  });
});
