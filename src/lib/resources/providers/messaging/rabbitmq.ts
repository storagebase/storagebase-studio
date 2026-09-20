import { BaseResourceProvider } from "../../base-provider";
import { loadResourceSdk } from "../../sdk-loader";
import { registerResourceProviderLoader } from "../../registry";
import {
  ResourceConfigError,
  ResourceConnectionError,
  ResourceNotFoundError,
  ResourceOperationUnsupportedError,
} from "../../errors";
import type {
  ResourceConnection,
  ResourceHealth,
  ResourceNode,
  ResourceNodePage,
  ResourceProviderCapabilities,
  ResourceProviderLabels,
} from "../../types";
import type { BrowseMessagesPage, MessagingOperations } from "../../operations";

/**
 * The RabbitMQ provider. AMQP addressing is the connection string
 * (`amqp://user:pass@host:port/vhost`) or a bare `endpoint` host, which the
 * form offers both of because operators keep both spellings around.
 *
 * Two surfaces, honestly separated:
 * - Reads and writes ride AMQP (browse via `basic.get`, publish, purge).
 * - DISCOVERY rides the management HTTP API (`GET /api/exchanges|queues`),
 *   derived from the AMQP address (`http://<host>:15672`), because AMQP has
 *   no list operation. A broker without the management plugin still
 *   publishes and purges; only the tree explains itself, carrying the derived
 *   URL in its sentence.
 *
 * Peek consumes with requeue (`nack(requeue: true)`): the messages stay
 * queued, but every peek redelivers — the viewer says so next to the list
 * rather than letting "browse" read as free. Purging a queue is the one real
 * `purgeQueue`; browsing an EXCHANGE is refused (exchanges hold no messages —
 * browse a bound queue).
 */

interface AmqpClient {
  connect(url: string): Promise<AmqpConnection>;
}

function loadAmqp(): Promise<AmqpClient> {
  // Literal specifier, not the helper default: knip resolves usage statically
  // and cannot follow the helper's variable import, while the bundlers must
  // still leave this out of the client graph (node-only SDK, server routes).
  return loadResourceSdk<AmqpClient>(
    "amqplib",
    "AMQP client (amqplib)",
    "bun add amqplib",
    () => import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "amqplib") as unknown as Promise<AmqpClient>,
  );
}

export const RABBITMQ_BROWSE_LIMIT = 100;

export const RABBITMQ_PREVIEW_CHARS = 200;

/**
 * The narrow slice of the amqplib surface this provider touches, stated
 * structurally rather than imported from `@types/amqplib`: the module loads
 * dynamically (node-only, never bundled), which knip cannot follow, so a
 * type-only import leaves a devDependency neither gate can see. The shapes
 * below mirror amqplib's documented API one for one; a narrower surface here
 * than the provider uses fails typecheck at the call site, not silently.
 */
interface AmqpMessage {
  content: Uint8Array;
  fields: { deliveryTag: number; redelivered: boolean; exchange: string; routingKey: string };
}

interface AmqpChannel {
  checkQueue(queue: string): Promise<unknown>;
  checkExchange(exchange: string): Promise<unknown>;
  get(queue: string, options?: { noAck?: boolean }): Promise<false | AmqpMessage>;
  nack(message: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  publish(
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): boolean;
  purgeQueue(queue: string): Promise<{ messageCount: number }>;
  close(): Promise<void>;
  on(event: string, listener: () => void): void;
}

interface AmqpClient {
  connect(url: string): Promise<AmqpConnection>;
}

interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
  on(event: string, listener: () => void): void;
}

/** Default exchange: the empty name routes on the queue name. Never listed (unaddressable for publish). */
const DEFAULT_EXCHANGE = "";

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`RabbitMQ ${what} failed: ${message}`);
}

function previewOf(value: Uint8Array | null): { preview: string; truncated: boolean } {
  if (value === null) return { preview: "", truncated: false };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(value.slice(0, RABBITMQ_PREVIEW_CHARS + 1));
  if (text.includes("�")) return { preview: "", truncated: true };
  return {
    preview: text.slice(0, RABBITMQ_PREVIEW_CHARS),
    truncated: text.length > RABBITMQ_PREVIEW_CHARS,
  };
}

interface AmqpAddressing {
  /** What `amqplib.connect` dials. */
  url: string;
  /** Management API base derived from it (`http://host:15672`). */
  managementBase: string;
  /** Management credentials from the userinfo, or guest for a bare endpoint. */
  managementUser: string;
  managementPassword: string;
}

export class RabbitMQProvider extends BaseResourceProvider implements MessagingOperations {
  protected validate(): void {
    super.validate();
    if (!this.config.connectionString && !this.config.endpoint) {
      throw new ResourceConfigError('A RabbitMQ connection requires a "connectionString" or an "endpoint" host');
    }
    // Scheme-checked here, not at dial time: a non-AMQP string is a record
    // error (400), never a dial failure (502).
    if (this.config.connectionString) {
      const protocol = this.config.connectionString.split("://")[0];
      if (protocol !== "amqp" && protocol !== "amqps") {
        throw new ResourceConfigError('RabbitMQ connectionString must start with "amqp://" or "amqps://"');
      }
    }
  }

  /** Parse once, at use, so constructor validation stays cheap and total. */
  private addressing(): AmqpAddressing {
    if (this.config.connectionString) {
      const parsed = new URL(this.config.connectionString);
      const host = parsed.hostname || "localhost";
      return {
        url: this.config.connectionString,
        managementBase: `http://${host}:15672`,
        managementUser: decodeURIComponent(parsed.username || "guest"),
        managementPassword: decodeURIComponent(parsed.password || "guest"),
      };
    }
    const endpoint = this.config.endpoint as string;
    const url = endpoint.includes("://") ? endpoint : `amqp://guest:guest@${endpoint}`;
    const host = new URL(url).hostname || "localhost";
    return { url, managementBase: `http://${host}:15672`, managementUser: "guest", managementPassword: "guest" };
  }

  private async withChannel<T>(run: (channel: AmqpChannel) => Promise<T>): Promise<T> {
    const sdk = await loadAmqp();
    const connection = await sdk.connect(this.addressing().url);
    // A refused check (unknown queue/exchange) makes the server CLOSE the
    // channel, which amqplib ALSO emits as an 'error' event: without a
    // listener that event crashes the process, ahead of the operation promise
    // that carries the same refusal to the catch blocks below. The listener
    // swallows nothing material — every refusal still rejects its own call.
    connection.on("error", () => undefined);
    try {
      const channel = await connection.createChannel();
      channel.on("error", () => undefined);
      try {
        return await run(channel);
      } finally {
        await channel.close().catch(() => undefined);
      }
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  public async connect(): Promise<void> {
    try {
      // AMQP connects eagerly: a refused credential or closed port fails here,
      // and the channel open-close proves the vhost exists.
      await this.withChannel(async () => undefined);
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    // No held handles: every operation opens and closes its own channel, so
    // there is nothing to tear down and a double call stays silent.
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    await this.withChannel(async () => undefined);
    return { status: "healthy", latencyMs: Date.now() - start };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "messaging",
      defaultPort: 5672,
      supportsSshTunnel: false,
      operations: ["tree", "message.browse", "message.publish", "message.purge"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Destinations", itemNoun: "Messages" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId !== null) return { nodes: [], truncated: false };
    try {
      const { managementBase, managementUser, managementPassword } = this.addressing();
      const authorization = `Basic ${Buffer.from(`${managementUser}:${managementPassword}`).toString("base64")}`;
      const get = async (path: string): Promise<Array<{ name: string }>> => {
        const response = await fetch(`${managementBase}${path}`, { headers: { authorization } });
        if (!response.ok) {
          throw new Error(`management API answered ${response.status} for ${path}`);
        }
        return (await response.json()) as Array<{ name: string }>;
      };
      const [exchanges, queues] = await Promise.all([get("/api/exchanges/%2f"), get("/api/queues/%2f")]);
      return {
        nodes: [
          ...exchanges
            // The nameless default exchange is unaddressable for publish, and
            // the amq.* predeclared set is broker furniture, not user surface —
            // both filtered structurally, the __-topic ruling applied here.
            .filter((exchange) => exchange.name !== DEFAULT_EXCHANGE && !exchange.name.startsWith("amq."))
            .map((exchange) => ({
              id: `exchange/${exchange.name}`,
              parentId: null,
              kind: "exchange",
              name: exchange.name,
              hasChildren: false,
            })),
          ...queues.map((queue) => ({
            id: `queue/${queue.name}`,
            parentId: null,
            kind: "queue",
            name: queue.name,
            hasChildren: false,
          })),
        ],
        truncated: false,
      };
    } catch (error) {
      throw toConnectionError(
        error,
        `list exchanges and queues (management API at ${this.addressing().managementBase}; brokers without the management plugin browse no tree)`,
      );
    }
  }

  public async listDestinations(): Promise<ResourceNodePage> {
    return this.listNodes(null);
  }

  /** Split a destination id back into its scheme and bare name. */
  private splitDestination(destination: string): { scheme: "queue" | "exchange"; name: string } {
    if (destination.startsWith("queue/")) return { scheme: "queue", name: destination.slice("queue/".length) };
    if (destination.startsWith("exchange/")) return { scheme: "exchange", name: destination.slice("exchange/".length) };
    // Bare names arrive from publish callers; the provider resolves them
    // against the broker (queue first) rather than guessing from punctuation.
    return { scheme: "queue", name: destination };
  }

  public async browseMessages(destination: string, limit: number): Promise<BrowseMessagesPage> {
    const bounded = Math.max(1, Math.min(limit, RABBITMQ_BROWSE_LIMIT));
    const { scheme, name } = this.splitDestination(destination);
    if (scheme !== "queue") {
      throw new ResourceOperationUnsupportedError(
        `Exchange "${name}" cannot be browsed: exchanges hold no messages — browse a bound queue`,
      );
    }
    try {
      return await this.withChannel(async (channel) => {
        try {
          await channel.checkQueue(name);
        } catch {
          throw new ResourceNotFoundError(`Queue "${name}" does not exist`);
        }
        const messages: ResourceNode[] = [];
        for (let i = 0; i < bounded; i += 1) {
          const message = await channel.get(name, { noAck: false });
          if (message === false) break;
          // Requeue immediately: the peek leaves the queue as it found it,
          // at the documented cost of one redelivery per message peeked.
          channel.nack(message, false, true);
          const body = message.content ?? null;
          const preview = previewOf(body);
          messages.push({
            id: `queue/${name}/${message.fields.deliveryTag}`,
            parentId: `queue/${name}`,
            kind: "message",
            name: `#${message.fields.deliveryTag}`,
            meta: {
              exchange: message.fields.exchange,
              routingKey: message.fields.routingKey,
              redelivered: message.fields.redelivered,
              preview: preview.preview,
              ...(preview.truncated ? { previewTruncated: true } : {}),
            },
            hasChildren: false,
          });
        }
        return { messages, truncated: messages.length >= bounded };
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError || error instanceof ResourceOperationUnsupportedError) throw error;
      throw toConnectionError(error, `browse "${destination}"`);
    }
  }

  public async publishMessage(destination: string, body: string, attributes?: Record<string, string>): Promise<void> {
    const { scheme, name } = this.splitDestination(destination);
    try {
      await this.withChannel(async (channel) => {
        if (scheme === "queue") {
          try {
            await channel.checkQueue(name);
          } catch {
            throw new ResourceNotFoundError(`Queue "${name}" does not exist`);
          }
          channel.publish(DEFAULT_EXCHANGE, name, Buffer.from(body), toPublishOptions(attributes));
          return;
        }
        try {
          await channel.checkExchange(name);
        } catch {
          throw new ResourceNotFoundError(`Exchange "${name}" does not exist`);
        }
        channel.publish(name, attributes?.routingKey ?? "", Buffer.from(body), toPublishOptions(attributes));
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `publish to "${destination}"`);
    }
  }

  public async purgeQueue(destination: string): Promise<void> {
    const { scheme, name } = this.splitDestination(destination);
    if (scheme !== "queue") {
      throw new ResourceOperationUnsupportedError(
        `Exchange "${name}" cannot be purged: purge removes queued messages, and exchanges queue none`,
      );
    }
    try {
      await this.withChannel(async (channel) => {
        try {
          await channel.purgeQueue(name);
        } catch {
          throw new ResourceNotFoundError(`Queue "${name}" does not exist`);
        }
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError || error instanceof ResourceOperationUnsupportedError) throw error;
      throw toConnectionError(error, `purge "${destination}"`);
    }
  }
}

function toPublishOptions(attributes?: Record<string, string>): { headers?: Record<string, string> } {
  if (!attributes) return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    // routingKey is addressing, not a header: it rode in `attributes` only
    // because publishMessage's signature carries one map, and the exchange
    // branch above already consumed it.
    if (name !== "routingKey") headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? { headers } : {};
}

registerResourceProviderLoader("rabbitmq", () => import("./rabbitmq").then((m) => ({ default: m.RabbitMQProvider })));
