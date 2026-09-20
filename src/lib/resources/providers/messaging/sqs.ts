import { BaseResourceProvider } from "../../base-provider";
import { registerResourceProviderLoader } from "../../registry";
import { ResourceConfigError, ResourceConnectionError, ResourceNotFoundError } from "../../errors";
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
 * The Amazon SQS provider. Standard AWS addressing — `region` plus keys,
 * with `endpoint` overriding the service URL for LocalStack (the same
 * endpoint-override ruling S3 follows for its wire relatives).
 *
 * Peek is `ReceiveMessage`, and the plan's risk register is quoted here
 * because the semantics are the feature's sharpest edge: SQS has no
 * non-destructive read, so peeking RECEIVES with `VisibilityTimeout: 0`,
 * which makes each message visible again immediately — at the documented
 * cost of redelivery races with real consumers, and possible duplication and
 * reordering. The viewer says so next to the list.
 *
 * Purge is the real `PurgeQueue` API (AWS allows one purge per queue per 60
 * seconds — a refusal there is the service's sentence, surfaced as-is).
 * FIFO queues need a `MessageGroupId` on send: `attributes.MessageGroupId`
 * when the caller names one, `"storagebase"` otherwise.
 */

import { loadResourceSdk } from "../../sdk-loader";

type SqsModule = typeof import("@aws-sdk/client-sqs");

function loadSqs(): Promise<SqsModule> {
  return loadResourceSdk<SqsModule>(
    "@aws-sdk/client-sqs",
    "AWS SDK (@aws-sdk/client-sqs)",
    "bun add @aws-sdk/client-sqs",
  );
}

export const SQS_BROWSE_LIMIT = 100;

/** Receive rounds per peek: 10 messages max per call, so the bound is pages. */
const SQS_RECEIVE_ROUNDS = 10;

export const SQS_PREVIEW_CHARS = 200;

function toConnectionError(error: unknown, what: string): ResourceConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  return new ResourceConnectionError(`SQS ${what} failed: ${message}`);
}

function isMissingQueue(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "QueueDoesNotExist" || name === "AWS.SimpleQueueService.NonExistentQueue";
}

function previewOf(value: string | null): { preview: string; truncated: boolean } {
  if (value === null) return { preview: "", truncated: false };
  if (value.includes("�")) return { preview: "", truncated: true };
  return {
    preview: value.slice(0, SQS_PREVIEW_CHARS),
    truncated: value.length > SQS_PREVIEW_CHARS,
  };
}

export class SqsProvider extends BaseResourceProvider implements MessagingOperations {
  private client: InstanceType<SqsModule["SQSClient"]> | null = null;

  protected validate(): void {
    super.validate();
    if (!this.config.region) {
      throw new ResourceConfigError('An SQS connection requires a "region"');
    }
  }

  private async getClient(): Promise<InstanceType<SqsModule["SQSClient"]>> {
    if (this.client) return this.client;
    const sdk = await loadSqs();
    this.client = new sdk.SQSClient({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      ...(this.config.accessKeyId
        ? {
            credentials: {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey ?? "",
              ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
            },
          }
        : {}),
    });
    return this.client;
  }

  private queueName(queueUrl: string): string {
    return queueUrl.split("/").filter(Boolean).pop() ?? queueUrl;
  }

  private async resolveQueueUrl(nameOrUrl: string): Promise<string> {
    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) return nameOrUrl;
    const client = await this.getClient();
    const sdk = await loadSqs();
    try {
      const response = await client.send(new sdk.GetQueueUrlCommand({ QueueName: nameOrUrl }));
      if (!response.QueueUrl) throw new ResourceNotFoundError(`Queue "${nameOrUrl}" does not exist`);
      return response.QueueUrl;
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      if (isMissingQueue(error)) throw new ResourceNotFoundError(`Queue "${nameOrUrl}" does not exist`);
      throw toConnectionError(error, `resolve queue "${nameOrUrl}"`);
    }
  }

  public async connect(): Promise<void> {
    try {
      // Like S3, REST with no socket: the probe lists queues so an unreachable
      // endpoint or refused credential fails HERE as unreachable.
      await this.listDestinations();
      this.setConnected(true);
    } catch (error) {
      if (error instanceof ResourceConnectionError) throw error;
      throw toConnectionError(error, "connect");
    }
  }

  public async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = null;
    this.setConnected(false);
  }

  public async getHealth(): Promise<ResourceHealth> {
    const start = Date.now();
    await this.listDestinations();
    return { status: "healthy", latencyMs: Date.now() - start };
  }

  public getCapabilities(): ResourceProviderCapabilities {
    return {
      category: "messaging",
      defaultPort: 443,
      supportsSshTunnel: false,
      operations: ["tree", "message.browse", "message.publish", "message.purge"],
    };
  }

  public getLabels(): ResourceProviderLabels {
    return { containerNoun: "Queues", itemNoun: "Messages" };
  }

  public async listNodes(parentId: string | null): Promise<ResourceNodePage> {
    if (parentId !== null) return { nodes: [], truncated: false };
    return this.listDestinations();
  }

  public async listDestinations(): Promise<ResourceNodePage> {
    try {
      const client = await this.getClient();
      const sdk = await loadSqs();
      const response = await client.send(new sdk.ListQueuesCommand({}));
      const urls = response.QueueUrls ?? [];
      return {
        nodes: urls.map((url) => {
          const name = this.queueName(url);
          return { id: `queue/${name}`, parentId: null, kind: "queue", name, hasChildren: false };
        }),
        truncated: false,
      };
    } catch (error) {
      throw toConnectionError(error, "list queues");
    }
  }

  public async browseMessages(destination: string, limit: number): Promise<BrowseMessagesPage> {
    const bounded = Math.max(1, Math.min(limit, SQS_BROWSE_LIMIT));
    try {
      const { name } = splitDestination(destination);
      const queueUrl = await this.resolveQueueUrl(name);
      const client = await this.getClient();
      const sdk = await loadSqs();
      const messages: ResourceNode[] = [];
      let drained = false;
      // VisibilityTimeout 0: each message is visible again the moment it is
      // read — the peek changes nothing durably, at the documented cost of
      // redelivery races (see the module docblock).
      for (let round = 0; round < SQS_RECEIVE_ROUNDS && messages.length < bounded; round += 1) {
        const response = await client.send(
          new sdk.ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: Math.min(10, bounded - messages.length),
            VisibilityTimeout: 0,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
          }),
        );
        const received = response.Messages ?? [];
        // An empty round is the only honest end-of-queue signal SQS gives:
        // stopping exactly at the bound without one means more may remain.
        if (received.length === 0) {
          drained = true;
          break;
        }
        for (const message of received) {
          const preview = previewOf(message.Body ?? null);
          messages.push({
            id: `queue/${name}/${message.MessageId ?? `${round}`}`,
            parentId: `queue/${name}`,
            kind: "message",
            name: message.MessageId ?? `#${messages.length}`,
            meta: {
              // AWS sends millis; LocalStack v3 sends micros (measured:
              // year 58688 when multiplied blindly). Magnitude decides.
              ...(message.Attributes?.SentTimestamp
                ? {
                    timestamp: new Date(
                      Number(message.Attributes.SentTimestamp) > 1e14
                        ? Math.floor(Number(message.Attributes.SentTimestamp) / 1000)
                        : Number(message.Attributes.SentTimestamp),
                    ).toISOString(),
                  }
                : {}),
              preview: preview.preview,
              ...(preview.truncated ? { previewTruncated: true } : {}),
            },
            hasChildren: false,
          });
          if (messages.length >= bounded) break;
        }
      }
      return { messages, truncated: !drained && messages.length >= bounded };
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `browse "${destination}"`);
    }
  }

  public async publishMessage(destination: string, body: string, attributes?: Record<string, string>): Promise<void> {
    try {
      const { name } = splitDestination(destination);
      const queueUrl = await this.resolveQueueUrl(name);
      const client = await this.getClient();
      const sdk = await loadSqs();
      const { MessageGroupId, ...rest } = attributes ?? {};
      await client.send(
        new sdk.SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          ...(Object.keys(rest).length > 0
            ? {
                MessageAttributes: Object.fromEntries(
                  Object.entries(rest).map(([key, value]) => [key, { DataType: "String", StringValue: value }]),
                ),
              }
            : {}),
          // FIFO queues refuse a send with no group; the caller's group wins,
          // otherwise a constant one (documented in docs/resources/sqs.md).
          ...(name.endsWith(".fifo") ? { MessageGroupId: MessageGroupId ?? "storagebase" } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `publish to "${destination}"`);
    }
  }

  public async purgeQueue(destination: string): Promise<void> {
    try {
      const { name } = splitDestination(destination);
      const queueUrl = await this.resolveQueueUrl(name);
      const client = await this.getClient();
      const sdk = await loadSqs();
      await client.send(new sdk.PurgeQueueCommand({ QueueUrl: queueUrl }));
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw toConnectionError(error, `purge "${destination}"`);
    }
  }
}

/**
 * Split a destination id back to its bare name. Ids are `queue/<name>`, but
 * publish callers may pass the bare name; queue names never contain `/`.
 */
function splitDestination(destination: string): { name: string } {
  return { name: destination.startsWith("queue/") ? destination.slice("queue/".length) : destination };
}

registerResourceProviderLoader("sqs", () => import("./sqs").then((m) => ({ default: m.SqsProvider })));
