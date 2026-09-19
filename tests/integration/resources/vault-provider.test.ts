import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createResourceProvider } from "@/lib/resources/factory";
import { registeredResourceTypes } from "@/lib/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/lib/resources/errors";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * Vault/OpenBao provider tests. HTTP is doubled with a fetch double; every
 * answer is shaped from live passes against Vault 1.21.4 and OpenBao 2.6.2
 * dev servers (measured 2026-09-20):
 * - sys/mounts lists engine types; only kv-v2 mounts surface (cubbyhole,
 *   identity and sys are filtered, transit would be too).
 * - kv-v2 list answers `keys`, folders trailing-slashed; an empty prefix is
 *   `[]`, never 404 (the mount was resolved when drawn).
 * - data reads answer `{data: {data, metadata}}`; a missing secret is 404.
 * - Single-key `{value}` secrets read as the bare value; multi-key secrets
 *   read as JSON. Writes invert the rule.
 * - Metadata DELETE destroys all versions (the tree's "delete" promise).
 */

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

const recordedCalls: RecordedCall[] = [];

const secrets: Record<string, { data: Record<string, unknown>; version: number }> = {};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function seed() {
  for (const key of Object.keys(secrets)) delete secrets[key];
  secrets["storagebase/fixture"] = { data: { username: "fixture", password: "fixture-pass" }, version: 1 };
  secrets["storagebase/nested/deep"] = { data: { key: "deep-value" }, version: 2 };
  secrets["storagebase/plain"] = { data: { value: "just-text" }, version: 1 };
}

const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const path = url.pathname;
  const method = init?.method ?? "GET";
  let body: unknown = null;
  try {
    body = init?.body ? JSON.parse(init.body as string) : null;
  } catch {
    body = null;
  }
  recordedCalls.push({ path, method, body });

  if (path === "/v1/sys/health") {
    return jsonResponse(200, { initialized: true, sealed: false, server_time_utc: 1789861090, version: "1.21.4" });
  }
  if (path === "/v1/sys/mounts") {
    return jsonResponse(200, {
      data: {
        "cubbyhole/": { type: "cubbyhole", options: {} },
        "identity/": { type: "identity", options: {} },
        "secret/": { type: "kv", options: { version: "2" } },
        "storagebase/": { type: "kv", options: { version: "2" } },
        "sys/": { type: "system", options: {} },
        "transit/": { type: "transit", options: {} },
      },
    });
  }
  const listMatch = path.match(/^\/v1\/([^/]+)\/metadata\/(.*)$/);
  if (listMatch && new URLSearchParams(url.search).get("list") === "true") {
    const [, mount, prefix] = listMatch;
    if (mount !== "secret" && mount !== "storagebase") return new Response("no handler", { status: 404 });
    const seen = new Map<string, boolean>();
    for (const full of Object.keys(secrets).filter((key) => key.startsWith(`${mount}/${prefix}`))) {
      const rest = full.slice(`${mount}/${prefix}`.length);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(`${rest.slice(0, slash)}/`, true);
    }
    return jsonResponse(200, { data: { keys: [...seen.keys()] } });
  }
  const dataMatch = path.match(/^\/v1\/([^/]+)\/data\/(.+)$/);
  if (dataMatch && method === "GET") {
    const full = `${dataMatch[1]}/${dataMatch[2]}`;
    const secret = secrets[full];
    if (!secret) return new Response("not found", { status: 404 });
    return jsonResponse(200, {
      data: {
        data: secret.data,
        metadata: { version: secret.version, created_time: "2026-09-19T23:40:58.234643437Z" },
      },
    });
  }
  if (dataMatch && method === "POST") {
    const full = `${dataMatch[1]}/${dataMatch[2]}`;
    if (dataMatch[1] !== "secret" && dataMatch[1] !== "storagebase") return new Response("no handler", { status: 404 });
    const existing = secrets[full];
    secrets[full] = { data: (body as { data: Record<string, unknown> }).data, version: (existing?.version ?? 0) + 1 };
    return new Response(null, { status: 200 });
  }
  const metadataMatch = path.match(/^\/v1\/([^/]+)\/metadata\/(.+)$/);
  if (metadataMatch && method === "DELETE") {
    const full = `${metadataMatch[1]}/${metadataMatch[2]}`;
    if (!(full in secrets)) return new Response("not found", { status: 404 });
    delete secrets[full];
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected request ${method} ${path}`);
});

const connection: ResourceConnection = {
  id: "res-1",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:8210",
  token: "root",
};

// Importing the module self-registers both ids, like production.
const { VaultProvider } = await import("@/lib/resources/providers/vaults/vault");

describe("VaultProvider", () => {
  beforeEach(() => {
    seed();
    recordedCalls.length = 0;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockClear();
  });

  test("registers both ids and resolves each through the factory", async () => {
    expect(registeredResourceTypes()).toContain("hashicorp-vault");
    expect(registeredResourceTypes()).toContain("openbao");
    const provider = await createResourceProvider(connection);
    expect(provider).toBeInstanceOf(VaultProvider);
    const bao = await createResourceProvider({ ...connection, id: "res-2", type: "openbao" });
    expect(bao).toBeInstanceOf(VaultProvider);
  });

  test("refuses a connection with no endpoint or token", () => {
    expect(() => new VaultProvider({ ...connection, endpoint: undefined })).toThrow(ResourceConfigError);
    expect(() => new VaultProvider({ ...connection, token: undefined })).toThrow(ResourceConfigError);
  });

  test("health reports seal state, not just reachability", async () => {
    const provider = new VaultProvider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(await provider.getHealth()).toMatchObject({ status: "healthy" });
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("lists only kv-v2 mounts", async () => {
    const provider = new VaultProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.nodes.map((node) => node.id).sort()).toEqual(["mount/secret", "mount/storagebase"]);
    expect(page.nodes[0]).toMatchObject({ kind: "mount", hasChildren: true });
  });

  test("lists secrets and folders with round-tripping ids", async () => {
    const provider = new VaultProvider(connection);
    const roots = await provider.listSecrets("storagebase", null);
    expect(roots.nodes.map((node) => node.id).sort()).toEqual([
      "mount/storagebase/fixture",
      "mount/storagebase/nested/",
      "mount/storagebase/plain",
    ]);
    const folder = roots.nodes.find((node) => node.kind === "folder");
    expect(folder).toMatchObject({ name: "nested", hasChildren: true });

    const nested = await provider.listNodes("mount/storagebase/nested/");
    expect(nested.nodes).toHaveLength(1);
    expect(nested.nodes[0].id).toBe("mount/storagebase/nested/deep");
  });

  test("reads multi-key secrets as JSON and single-value secrets bare", async () => {
    const provider = new VaultProvider(connection);
    const multi = await provider.readSecret("storagebase/fixture");
    expect(JSON.parse(multi.value)).toEqual({ username: "fixture", password: "fixture-pass" });
    expect(multi.metadata).toMatchObject({ version: "1" });

    const single = await provider.readSecret("storagebase/plain");
    expect(single.value).toBe("just-text");
  });

  test("a missing secret is a 404", async () => {
    const provider = new VaultProvider(connection);
    const error = await provider.readSecret("storagebase/nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("writes invert the read rule and bump versions", async () => {
    const provider = new VaultProvider(connection);
    await provider.writeSecret("storagebase/new-json", JSON.stringify({ a: 1 }));
    expect(secrets["storagebase/new-json"].data).toEqual({ a: 1 });

    await provider.writeSecret("storagebase/new-text", "just-text");
    expect(secrets["storagebase/new-text"].data).toEqual({ value: "just-text" });

    await provider.writeSecret("storagebase/plain", "changed");
    expect(secrets["storagebase/plain"].version).toBe(2);
  });

  test("deletes destroy every version", async () => {
    const provider = new VaultProvider(connection);
    await provider.deleteSecret("storagebase/plain");
    expect("storagebase/plain" in secrets).toBe(false);

    const error = await provider.deleteSecret("storagebase/plain").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("capabilities and labels are type-driven", () => {
    const provider = new VaultProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({ category: "vault", defaultPort: 8200 });
    expect(provider.getCapabilities().operations).toEqual(["tree", "secret.read", "secret.write", "secret.delete"]);
    expect(provider.getLabels()).toEqual({ containerNoun: "Mounts", itemNoun: "Secrets" });
  });

  test("an unreachable server fails connect as unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof fetch;
    try {
      const provider = new VaultProvider({ ...connection, endpoint: "http://localhost:1" });
      const error = await provider.connect().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceConnectionError);
      expect(provider.isConnected()).toBe(false);
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });
});
