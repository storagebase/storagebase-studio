import { createHash } from "node:crypto";
import type { ForkStore } from "@/lib/fork-store";
import { encryptSecret, readSecret } from "@/lib/storage/encryption";
import type { UserConnectionFamily } from "./ids";
import type { SecretBag } from "./secrets";

/**
 * Where a user's connection secrets live (StorageBase fork): one fork-store record per connection,
 * beside — never inside — the `connections` / `resource_connections` collections the browser
 * syncs. Every value is sealed with the storage encryption before it is written, and no route
 * ever returns one: the only readers are the server-side resolvers.
 *
 * The record kind carries a digest of the user name, so a user's records are one indexed range
 * of the store and the user name itself (often an e-mail) is not a key in it. A second user
 * saving a connection with the same id writes a different record.
 */

export interface UserSecretRecord {
  /** `targetFingerprint` of the row the secrets were saved for. */
  target: string;
  /** Secret path to SEALED value. */
  secrets: SecretBag;
  updatedAt: string;
}

export function secretRecordKind(username: string, family: UserConnectionFamily): string {
  const digest = createHash("sha256").update(username).digest("hex").slice(0, 40);
  return `user-secrets:${family}:${digest}`;
}

/** Record ids are connection ids, stored beside the value so a listing can key on them. */
interface StoredRecord extends UserSecretRecord {
  id: string;
}

export async function loadSecretRecords(
  store: ForkStore,
  username: string,
  family: UserConnectionFamily,
): Promise<Map<string, UserSecretRecord>> {
  const rows = await store.listRecords<StoredRecord>(secretRecordKind(username, family));
  return new Map(rows.map(({ id, ...record }) => [id, record]));
}

export async function putSecretRecord(
  store: ForkStore,
  username: string,
  family: UserConnectionFamily,
  id: string,
  record: UserSecretRecord,
): Promise<void> {
  await store.putRecord<StoredRecord>(secretRecordKind(username, family), id, { id, ...record }, username);
}

export async function deleteSecretRecord(
  store: ForkStore,
  username: string,
  family: UserConnectionFamily,
  id: string,
): Promise<void> {
  await store.deleteRecord(secretRecordKind(username, family), id);
}

/** Seals every value not already sealed under the current key. */
export function sealSecrets(secrets: SecretBag): SecretBag {
  return Object.fromEntries(
    Object.entries(secrets).map(([path, value]) => [
      path,
      readSecret(value).kind === "decrypted" ? value : encryptSecret(value),
    ]),
  );
}

/** Opens sealed values; one that no longer opens under the current key is omitted and counted. */
export function openSecrets(sealed: SecretBag): { secrets: SecretBag; undecryptable: number } {
  const secrets: SecretBag = {};
  let undecryptable = 0;
  for (const [path, value] of Object.entries(sealed)) {
    const result = readSecret(value);
    if (result.kind === "undecryptable") undecryptable += 1;
    else secrets[path] = result.value;
  }
  return { secrets, undecryptable };
}
