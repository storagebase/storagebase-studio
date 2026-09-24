import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type { SecretRead, VaultOperations } from "../../operations";

/**
 * The HashiCorp Vault provider — and OpenBao through the same module (one
 * module, two ids, the opensearch precedent): OpenBao is API-compatible for
 * everything this surface touches. No SDK: the Vault API is plain REST and
 * `node-vault` is unmaintained, so the module speaks HTTP via `fetch` (the
 * workstream-A decision, documented in docs/resources/README.md).
 *
 * Addressing: paths carry their mount (`storagebase/fixture` reads key
 * `fixture` under kv-v2 mount `storagebase`). Only kv-v2 mounts are listed —
 * a cubbyhole or transit mount in the tree would be an addressable-looking
 * row the secret calls cannot read, so mounts filter on `type: "kv"` with
 * `options.version === "2"`.
 *
 * Values: kv stores JSON objects, but `SecretRead.value` is one string, so
 * the provider serializes single-key `{value}` secrets to the bare value and
 * anything else to JSON. Writes invert it: text that parses as JSON is
 * stored as the parsed object, anything else as `{value}`. Both directions
 * are documented in docs/resources/hashicorp-vault.md because a caller that
 * guesses the rule corrupts secrets.
 */

interface VaultMountsResponse {
  data?: Record<string, { type?: string; options?: { version?: string } }>;
}

interface VaultListResponse {
  data?: { keys?: string[] };
}

interface VaultSecretResponse {
  data?: { data?: Record<string, unknown>; metadata?: { version?: string | number; created_time?: string } };
}

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`Vault ${what} failed: ${message}`);
}

function splitSecretPath(path: string): { mount: string; relative: string } {
  const slash = path.indexOf("/");
  if (slash === -1) {
    throw new ResourceNotFoundError(`Secret path "${path}" names no mount (expected "<mount>/<path>")`);
  }
  return { mount: path.slice(0, slash), relative: path.slice(slash + 1) };
}

export class VaultProvider extends BaseResourceProvider implements VaultOperations {
  protected validate(): void {
    super.validate();
    if (!this.config.endpoint) {
      throw new ResourceConfigError('A Vault connection requires an "endpoint" server address');
    }
    if (!this.config.token) {
      throw new ResourceConfigError('A Vault connection requires a "token"');
    }
  }

  private baseUrl(): string {
    return (this.config.endpoint as string).replace(/\/$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, {
        ...init,
        headers: {
          "X-Vault-Token": this.config.token as string,
          ...(this.config.namespace ? { "X-Vault-Namespace": this.config.namespace } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      throw toConnectionError(error, `request ${path}`);
    }
    return response;
  }

  private async readJson(path: string, what: string): Promise<unknown> {
    const response = await this.request(path);
    if (response.status === 404) throw new ResourceNotFoundError(`Vault ${what} does not exist`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw toConnectionError(
        new Error(`${what} answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`),
        what,
      );
    }
    return (await response.json().catch(() => null)) as unknown;
  }

  public async connect(): Promise<void> {
    try {
      // The health read is the probe: token, address and seal state in one call.
      await this.getHealth();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    // Token auth holds no socket: nothing to tear down, and a double call
    // stays silent like every other provider's.
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    const response = await this.request("/v1/sys/health");
    // Vault answers 200 unsealed, 429 standby, 472/473 sealed/recovery-mode:
    // anything but those is the service failing, not a state to report.
    if (![200, 429, 472, 473].includes(response.status)) {
      throw toConnectionError(new Error(`health answered ${response.status}`), "health check");
    }
    const health = (await response.json().catch(() => null)) as {
      initialized?: boolean;
      sealed?: boolean;
      server_time_utc?: number;
    } | null;
    const latencyMs = Date.now() - start;
    if (health?.sealed === true) {
      return { status: "degraded", message: "Vault is sealed: unseal it before reading secrets", latencyMs };
    }
    return { status: "healthy", latencyMs };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "vault",
      defaultPort: 8200,
      supportsSshTunnel: false,
      // The workbench flags (basic-workbench.ts serves them): no soft
      // delete, no secret properties, no certificates on this service.
      operations: [
        "tree",
        "secret.read",
        "secret.write",
        "secret.delete",
        "vault.secrets",
        "vault.secret.reveal",
        "vault.secret.write",
        "vault.delete",
      ],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Mounts", itemNoun: "Secrets" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId === null) return this.listMounts();
    const { mount, relative } = splitMountNode(parentId);
    return this.listSecrets(mount, relative);
  }

  public async listMounts(): Promise<ResourceNodePage> {
    const body = (await this.readJson("/v1/sys/mounts", "mount listing")) as VaultMountsResponse;
    const mounts = Object.entries(body.data ?? {})
      .filter(([, mount]) => mount.type === "kv" && mount.options?.version === "2")
      .map(([path]) => path.replace(/\/$/, ""));
    return {
      nodes: mounts.map((mount) => ({
        id: `mount/${mount}`,
        parentId: null,
        kind: "mount",
        name: mount,
        hasChildren: true,
      })),
      truncated: false,
    };
  }

  public async listSecrets(mount: string, prefix: string | null): Promise<ResourceNodePage> {
    const queryPrefix = prefix === null ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
    const body = (await this.readJson(
      `/v1/${mount}/metadata/${queryPrefix}?list=true`,
      `secret listing under "${mount}/${queryPrefix}"`,
    )) as VaultListResponse;
    // A 404 here means "no secrets under this prefix", not "no mount": the
    // mount was resolved when the tree drew it, and an empty folder reads
    // empty rather than failing (the D31 ruling, applied to vault paths).
    const keys = body.data?.keys ?? [];
    const base = prefix === null ? `mount/${mount}` : `mount/${mount}/${prefix}`;
    return {
      nodes: keys.map((key) => {
        const folder = key.endsWith("/");
        const name = folder ? key.slice(0, -1) : key;
        return {
          id: childId(base, name, folder),
          parentId: base,
          kind: folder ? "folder" : "secret",
          name,
          hasChildren: folder,
        };
      }),
      truncated: false,
    };
  }

  public async readSecret(path: string): Promise<SecretRead> {
    const { mount, relative } = splitSecretPath(path);
    const body = (await this.readJson(`/v1/${mount}/data/${relative}`, `secret "${path}"`)) as VaultSecretResponse;
    if (!body.data?.data) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
    const data = body.data.data;
    const keys = Object.keys(data);
    return {
      name: path,
      value:
        keys.length === 1 && keys[0] === "value" && typeof data.value === "string" ? data.value : JSON.stringify(data),
      metadata: {
        version: body.data.metadata?.version === undefined ? null : String(body.data.metadata.version),
        createdAt: body.data.metadata?.created_time ?? null,
      },
    };
  }

  public async writeSecret(path: string, value: string): Promise<void> {
    const { mount, relative } = splitSecretPath(path);
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(value);
      data =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value };
    } catch {
      data = { value };
    }
    const response = await this.request(`/v1/${mount}/data/${relative}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (response.status === 404) throw new ResourceNotFoundError(`Mount "${mount}" does not exist`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw toConnectionError(
        new Error(`write answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`),
        `write "${path}"`,
      );
    }
  }

  public async deleteSecret(path: string): Promise<void> {
    const { mount, relative } = splitSecretPath(path);
    // Metadata delete destroys ALL versions: the most destructive form, and
    // the only one the tree's "delete" can honestly mean (a version delete
    // would leave the secret readable). The workbench asks for the typed name.
    const response = await this.request(`/v1/${mount}/metadata/${relative}`, { method: "DELETE" });
    if (response.status === 404) throw new ResourceNotFoundError(`Secret "${path}" does not exist`);
    if (!response.ok && response.status !== 204) {
      const text = await response.text().catch(() => "");
      throw toConnectionError(
        new Error(`delete answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`),
        `delete "${path}"`,
      );
    }
  }
}

/**
 * Join a child name onto a level address. Folder parents end in `/`, mount
 * roots do not; the join respects either so ids never double-slash
 * (measured against dev Vault: `nested//deep` before this helper existed).
 */
function childId(base: string, name: string, isFolder: boolean): string {
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${name}${isFolder ? "/" : ""}`;
}

/**
 * Split a tree node id back into its mount and prefix. Ids are
 * `mount/<name>` and `mount/<name>/<path-or-folder>`; mount names never
 * contain `/`, so the first segment after `mount/` is always the mount.
 */
function splitMountNode(nodeId: string): { mount: string; relative: string | null } {
  const rest = nodeId.startsWith("mount/") ? nodeId.slice("mount/".length) : nodeId;
  const slash = rest.indexOf("/");
  if (slash === -1) return { mount: rest, relative: null };
  const relative = rest.slice(slash + 1);
  return { mount: rest.slice(0, slash), relative: relative === "" ? null : relative };
}

registerResourceProviderLoader("hashicorp-vault", () => import("./vault").then((m) => ({ default: m.VaultProvider })));
registerResourceProviderLoader("openbao", () => import("./vault").then((m) => ({ default: m.VaultProvider })));
