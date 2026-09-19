import { ResourceConfigError } from "./errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "./types";

/**
 * The strategy base every resource provider extends — the parallel of
 * `BaseDatabaseProvider`, at the weight this surface needs.
 *
 * M1 ships the spine; the family modules (blob, messaging, vault) land in M2-M4
 * and implement the family operation interfaces declared in ./operations.ts.
 * This class owns only what is common to every family: lifecycle, health, the
 * metadata pair the UI reads before connecting, and the ONE read every family
 * shares — the bounded tree walk.
 */
export abstract class BaseResourceProvider {
  public readonly type: ResourceConnection["type"];
  protected readonly config: ResourceConnection;
  protected connected = false;

  constructor(config: ResourceConnection) {
    this.type = config.type;
    this.config = config;
    this.validate();
  }

  /** The record the provider was built from, without its credential fields. */
  public describe(): { id: string; name: string; type: ResourceConnection["type"] } {
    return { id: this.config.id, name: this.config.name, type: this.config.type };
  }

  public isConnected(): boolean {
    return this.connected;
  }

  protected setConnected(value: boolean): void {
    this.connected = value;
  }

  /**
   * The cheap, type-driven refusal. Providers override to require the
   * addressing their family needs (an endpoint for Vault, a region or an
   * endpoint override for S3) and throw `ResourceConfigError`; the base refuses
   * only what no provider can live without.
   */
  protected validate(): void {
    if (!this.config.id) throw new ResourceConfigError('A resource connection requires an "id"');
    if (!this.config.type) throw new ResourceConfigError('A resource connection requires a "type"');
  }

  /** Opens the client. Implementations set the connected flag through `setConnected`. */
  public abstract connect(): Promise<void>;

  /** Closes the client and every handle it opened. Never throws for a double call. */
  public abstract disconnect(): Promise<void>;

  /** The service's answer to "are you alive", for the sidebar pulse and the test route. */
  public abstract getHealth(): Promise<ResourceHealth>;

  /** Type-driven, no socket required — what /api/resources/meta answers. */
  public abstract getCapabilities(): ResourceProviderCapabilities;

  public abstract getLabels(): ResourceProviderLabels;

  /**
   * The children of one node, or the roots when `parentId` is null. Bounded by
   * the provider; the page's `truncated` flag is the honest sentence about the
   * bound, the ruling the DB object surface follows (#789).
   */
  public abstract listNodes(parentId: string | null): Promise<ResourceNodePage>;
}
