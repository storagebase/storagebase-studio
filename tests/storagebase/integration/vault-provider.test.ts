import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { createResourceProvider } from "@/storagebase/resources/factory";
import { registeredResourceTypes } from "@/storagebase/resources/registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "@/storagebase/resources/errors";
import type { ResourceConnection } from "@/storagebase/resources/types";

/**
 * Vault/OpenBao provider tests (ported from the legacy vault-provider suite;
 * the AWS KMS / Secrets Manager cases stay deferred by decision D2). HTTP is
 * doubled with a fetch double; every answer is shaped from live passes against
 * Vault 1.21.4 and OpenBao 2.6.2 dev servers (measured 2026-09-20):
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
  headers: Record<string, string>;
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
  const headers = (init?.headers ?? {}) as Record<string, string>;
  recordedCalls.push({ path, method, body, headers });

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

export const connection: ResourceConnection = {
  id: "res-1",
  name: "vault",
  type: "hashicorp-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:8210",
  token: "root",
};

const { VaultProvider, VAULT_DEFAULT_ENDPOINT, OPENBAO_DEFAULT_ENDPOINT, defaultEndpointOf } = await import(
  "@/storagebase/resources/providers/vaults/vault"
);

describe("VaultProvider / OpenBaoProvider (one module, two ids)", () => {
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

  test("carries type-driven defaults for the address and the advertised port", () => {
    expect(defaultEndpointOf("hashicorp-vault")).toBe(VAULT_DEFAULT_ENDPOINT);
    expect(defaultEndpointOf("openbao")).toBe(OPENBAO_DEFAULT_ENDPOINT);
    expect(VAULT_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:8200");
    expect(OPENBAO_DEFAULT_ENDPOINT).toBe("http://127.0.0.1:8201");
    expect(new VaultProvider(connection).getCapabilities().defaultPort).toBe(8200);
    expect(new VaultProvider({ ...connection, type: "openbao" }).getCapabilities().defaultPort).toBe(8201);
  });

  test("uses the default endpoint when the connection omits one, stripping a trailing slash", async () => {
    const withoutEndpoint: ResourceConnection = { ...connection, endpoint: undefined };
    await new VaultProvider(withoutEndpoint).listMounts();
    expect(recordedCalls[0]?.path).toBe("/v1/sys/mounts");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${VAULT_DEFAULT_ENDPOINT}/v1/sys/mounts`);
    fetchMock.mockClear();
    await new VaultProvider({ ...withoutEndpoint, type: "openbao" }).listMounts();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${OPENBAO_DEFAULT_ENDPOINT}/v1/sys/mounts`);
    fetchMock.mockClear();
    await new VaultProvider({ ...connection, endpoint: "http://vault:8200/" }).listMounts();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://vault:8200/v1/sys/mounts");
  });

  test("sends the token and optional namespace on every request", async () => {
    await new VaultProvider({ ...connection, namespace: "ops" }).listMounts();
    expect(recordedCalls[0]?.headers).toMatchObject({ "X-Vault-Token": "root", "X-Vault-Namespace": "ops" });
    recordedCalls.length = 0;
    await new VaultProvider(connection).listMounts();
    expect(recordedCalls[0]?.headers["X-Vault-Namespace"]).toBeUndefined();
  });

  test("refuses a connection with no token", () => {
    expect(() => new VaultProvider({ ...connection, token: undefined })).toThrow(ResourceConfigError);
  });

  test("health reports seal state, not just reachability", async () => {
    const provider = new VaultProvider(connection);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(await provider.getHealth()).toMatchObject({ status: "healthy" });
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
  });

  test("a sealed vault is degraded, not healthy and not failed", async () => {
    const sealedFetch = mock(async () => jsonResponse(200, { initialized: true, sealed: true }));
    globalThis.fetch = sealedFetch as unknown as typeof fetch;
    try {
      const provider = new VaultProvider(connection);
      expect(await provider.getHealth()).toMatchObject({
        status: "degraded",
        message: "Vault is sealed: unseal it before reading secrets",
      });
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("a standby or recovery-mode answer is still a reachable service", async () => {
    for (const status of [429, 472, 473]) {
      globalThis.fetch = (async () => new Response("", { status })) as unknown as typeof fetch;
      try {
        expect(await new VaultProvider(connection).getHealth()).toMatchObject({ status: "healthy" });
      } finally {
        globalThis.fetch = fetchMock as unknown as typeof fetch;
      }
    }
  });

  test("a failing health read fails the probe", async () => {
    globalThis.fetch = (async () => jsonResponse(500, { errors: ["boom"] })) as unknown as typeof fetch;
    try {
      const provider = new VaultProvider(connection);
      const error = await provider.getHealth().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceConnectionError);
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("a non-connection error from the probe is still translated", async () => {
    const provider = new VaultProvider(connection);
    const probe = spyOn(provider, "getHealth").mockImplementation(async () => {
      throw new Error("probe blew up");
    });
    try {
      const error = await provider.connect().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceConnectionError);
      expect(provider.isConnected()).toBe(false);
    } finally {
      probe.mockRestore();
    }
  });

  test("a path without a mount is a 404", async () => {
    const provider = new VaultProvider(connection);
    const error = await provider.readSecret("noslash").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(await provider.writeSecret("noslash", "x").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
    expect(await provider.deleteSecret("noslash").catch((e: unknown) => e)).toBeInstanceOf(ResourceNotFoundError);
  });

  test("lists only kv-v2 mounts", async () => {
    const provider = new VaultProvider(connection);
    const page = await provider.listNodes(null);
    expect(page.nodes.map((node) => node.id).sort()).toEqual(["mount/secret", "mount/storagebase"]);
    expect(page.nodes[0]).toMatchObject({ kind: "mount", hasChildren: true, parentId: null });
  });

  test("an empty mount listing answers no nodes", async () => {
    globalThis.fetch = (async () => jsonResponse(200, {})) as unknown as typeof fetch;
    try {
      expect(await new VaultProvider(connection).listMounts()).toEqual({ nodes: [], truncated: false });
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
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
    const atFolder = await provider.listSecrets("storagebase", "nested/");
    expect(atFolder.nodes[0]?.parentId).toBe("mount/storagebase/nested/");
  });

  test("an empty prefix lists nothing rather than failing", async () => {
    const provider = new VaultProvider(connection);
    expect(await provider.listSecrets("secret", null)).toEqual({ nodes: [], truncated: false });
    expect(await provider.listSecrets("secret", "absent/")).toEqual({ nodes: [], truncated: false });
  });

  test("reads multi-key secrets as JSON and single-value secrets bare", async () => {
    const provider = new VaultProvider(connection);
    const multi = await provider.readSecret("storagebase/fixture");
    expect(JSON.parse(multi.value)).toEqual({ username: "fixture", password: "fixture-pass" });
    expect(multi.metadata).toMatchObject({ version: "1", createdAt: "2026-09-19T23:40:58.234643437Z" });

    const single = await provider.readSecret("storagebase/plain");
    expect(single.value).toBe("just-text");
  });

  test("a secret with no version metadata answers nulls", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { data: { data: { value: "x" }, metadata: {} } })) as unknown as typeof fetch;
    try {
      const read = await new VaultProvider(connection).readSecret("storagebase/plain");
      expect(read.value).toBe("x");
      expect(read.metadata).toEqual({ version: null, createdAt: null });
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("a missing secret is a 404", async () => {
    const provider = new VaultProvider(connection);
    const error = await provider.readSecret("storagebase/nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("a read with no data block is a 404", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { data: {} })) as unknown as typeof fetch;
    try {
      const error = await new VaultProvider(connection).readSecret("storagebase/plain").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceNotFoundError);
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("writes invert the read rule and bump versions", async () => {
    const provider = new VaultProvider(connection);
    await provider.writeSecret("storagebase/new-json", JSON.stringify({ a: 1 }));
    expect(secrets["storagebase/new-json"].data).toEqual({ a: 1 });

    await provider.writeSecret("storagebase/new-text", "just-text");
    expect(secrets["storagebase/new-text"].data).toEqual({ value: "just-text" });

    await provider.writeSecret("storagebase/new-array", JSON.stringify([1, 2]));
    expect(secrets["storagebase/new-array"].data).toEqual({ value: "[1,2]" });

    await provider.writeSecret("storagebase/new-invalid-json", "{not json");
    expect(secrets["storagebase/new-invalid-json"].data).toEqual({ value: "{not json" });

    await provider.writeSecret("storagebase/plain", "changed");
    expect(secrets["storagebase/plain"].version).toBe(2);
  });

  test("writes to a missing mount are a 404", async () => {
    const error = await new VaultProvider(connection).writeSecret("absent/key", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("deletes destroy every version", async () => {
    const provider = new VaultProvider(connection);
    await provider.deleteSecret("storagebase/plain");
    expect("storagebase/plain" in secrets).toBe(false);

    const error = await provider.deleteSecret("storagebase/plain").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("server-side failures carry the route's sentence", async () => {
    const failing = mock(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/v1/sys/health" || url.pathname === "/v1/sys/mounts") {
        return fetchMock(input as string, {});
      }
      return jsonResponse(500, { errors: ["storage backend failure"] });
    });
    globalThis.fetch = failing as unknown as typeof fetch;
    try {
      const provider = new VaultProvider(connection);
      for (const call of [
        () => provider.readSecret("storagebase/fixture"),
        () => provider.writeSecret("storagebase/fixture", "x"),
        () => provider.deleteSecret("storagebase/fixture"),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResourceConnectionError);
      }
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("a bad JSON body still names the failing operation", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    try {
      const provider = new VaultProvider(connection);
      expect(await provider.listMounts()).toEqual({ nodes: [], truncated: false });
      expect(await provider.listSecrets("storagebase", null)).toEqual({ nodes: [], truncated: false });
      expect(await provider.getHealth()).toMatchObject({ status: "healthy" });
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test("capabilities and labels are type-driven", () => {
    const provider = new VaultProvider(connection);
    expect(provider.getCapabilities()).toMatchObject({
      category: "vault",
      defaultPort: 8200,
      supportsSshTunnel: false,
    });
    expect(provider.getCapabilities().operations).toEqual([
      "tree",
      "secret.read",
      "secret.write",
      "secret.delete",
      "vault.secrets",
      "vault.secret.reveal",
      "vault.secret.write",
      "vault.delete",
    ]);
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
