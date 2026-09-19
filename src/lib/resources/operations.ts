import type { ResourceHealth, ResourceNode, ResourceNodePage } from "./types";

/**
 * The family operation interfaces, declared with the spine (M1) and implemented
 * by the provider modules as they land (M2-M4). They are separate interfaces
 * on purpose: a route downcasts only after checking the provider's declared
 * `operations`, so an unsupported operation is a 400 the ROUTE decides — never
 * a method the caller had to probe for.
 *
 * Reads are bounded with an explicit truncation flag; writes are the
 * full-management surface the fork committed to (confirm dialogs and audit
 * events live at the routes, not here).
 */

export interface BlobObjectMeta {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly lastModified: string | null;
  readonly contentType: string | null;
}

export interface BlobDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
}

export interface BlobPreview {
  /** What the preview decided the body is, so the viewer picks a pane, not a guess. */
  readonly kind: "text" | "image" | "binary";
  readonly text?: string;
  readonly truncated: boolean;
  readonly contentType: string | null;
}

export interface BlobOperations {
  listBuckets(): Promise<ResourceNodePage>;
  listObjects(bucket: string, prefix: string | null): Promise<ResourceNodePage>;
  readBlobMeta(bucket: string, name: string): Promise<BlobObjectMeta>;
  downloadBlob(bucket: string, name: string): Promise<BlobDownload>;
  previewBlob(bucket: string, name: string, byteLimit: number): Promise<BlobPreview>;
  uploadBlob(bucket: string, name: string, body: ReadableStream<Uint8Array>): Promise<BlobObjectMeta>;
  deleteBlob(bucket: string, name: string): Promise<void>;
}

export interface BrowseMessagesPage {
  readonly messages: readonly ResourceNode[];
  readonly truncated: boolean;
}

export interface MessagingOperations {
  listDestinations(): Promise<ResourceNodePage>;
  browseMessages(destination: string, limit: number): Promise<BrowseMessagesPage>;
  publishMessage(destination: string, body: string, attributes?: Record<string, string>): Promise<void>;
  purgeQueue(destination: string): Promise<void>;
}

export interface SecretVersion {
  readonly version: string | null;
  readonly createdAt: string | null;
}

export interface SecretRead {
  readonly name: string;
  readonly value: string;
  readonly metadata: SecretVersion | null;
}

export interface VaultOperations {
  listMounts(): Promise<ResourceNodePage>;
  listSecrets(mount: string, prefix: string | null): Promise<ResourceNodePage>;
  readSecret(path: string): Promise<SecretRead>;
  writeSecret(path: string, value: string): Promise<void>;
  deleteSecret(path: string): Promise<void>;
}

/** Narrowing helpers the routes use after the capability check. */
export function asBlobOperations(provider: object): BlobOperations | null {
  return "listBuckets" in provider ? (provider as BlobOperations) : null;
}

export function asMessagingOperations(provider: object): MessagingOperations | null {
  return "listDestinations" in provider ? (provider as MessagingOperations) : null;
}

export function asVaultOperations(provider: object): VaultOperations | null {
  return "listMounts" in provider ? (provider as VaultOperations) : null;
}
